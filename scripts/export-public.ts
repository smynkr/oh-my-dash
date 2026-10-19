#!/usr/bin/env bun
// Mirrors dash into a checkout of the public smynkr/oh-my-dash (AGENTS.md, AXI-448).
// Export-owned paths are replaced from the dash ref; public-owned docs and licence files are never touched.
// Any private identifier or gitleaks finding in the exported files fails the export before anything is committed.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const EXPORT_PATHS = ["src", "scripts", "test", "public", "omp-extension", "launchd", "bun.lock", ".gitignore", "package.json"];
/** Kept from the public repo's package.json: the mirror publishes under its own identity. */
export const PUBLIC_IDENTITY_KEYS = ["name", "version", "license", "repository"];
/** Tailscale CGNAT addresses. Real hostnames, accounts and labels live in the repo-root `.export-deny` (never exported). */
const TAILNET_IP = /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/;
/** One case-insensitive regular expression per line; blank lines and `#` comments are ignored. */
export async function loadDenyPatterns(repo: string): Promise<RegExp[]> {
  const text = await readFile(join(repo, ".export-deny"), "utf8");
  return [TAILNET_IP, ...text.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => new RegExp(line, "i"))];
}

type Args = { ref: string; target: string; dryRun: boolean; repo: string };
export function parseArgs(argv: string[]): Args {
  const result: Args = { ref: "HEAD", target: "", dryRun: false, repo: resolve(import.meta.dir, "..") };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (flag === "--dry-run") result.dryRun = true;
    else if (flag === "--ref") result.ref = value();
    else if (flag === "--target") result.target = value();
    else if (flag === "--repo") result.repo = value();
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!result.target) throw new Error("--target <oh-my-dash checkout> is required");
  return result;
}

const git = (cwd: string, args: string[]) => {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.toString().trim()}`);
  return run.stdout;
};

export function denyHits(path: string, text: string, patterns: RegExp[]): string[] {
  return text.split("\n").flatMap((line, n) => patterns.some(p => p.test(line)) ? [`${path}:${n + 1}`] : []);
}

export async function exportPublic(args: Args): Promise<string[]> {
  const repo = resolve(args.repo), target = resolve(args.target);
  if (git(target, ["status", "--porcelain"]).toString().trim()) throw new Error("target checkout is not clean");
  // A symlink in the target would redirect the export's writes outside the checkout.
  const links = git(target, ["ls-files", "-s", "-z", "--", ...EXPORT_PATHS]).toString().split("\0").filter(line => line.startsWith("120000 "));
  if (links.length) throw new Error(`target has symlinks under export paths: ${links.map(line => line.split("\t")[1]).join(", ")}`);
  const entries = git(repo, ["ls-tree", "-r", "-z", args.ref, "--", ...EXPORT_PATHS]).toString().split("\0").filter(Boolean)
    .map(line => { const [meta, path] = line.split("\t"); const [mode, type, oid] = meta!.split(" "); return { mode: mode!, type: type!, oid: oid!, path: path! }; })
    .filter(entry => entry.type === "blob");
  const files = new Map<string, { bytes: Uint8Array; mode: string }>();
  for (const entry of entries) files.set(entry.path, { bytes: git(repo, ["cat-file", "blob", entry.oid]), mode: entry.mode });

  const pkg = files.get("package.json");
  if (pkg) {
    const ours = JSON.parse(new TextDecoder().decode(pkg.bytes)), theirs = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    // Keep the public key order so the published diff shows only real changes; keys new in dash follow.
    // Identity keys are public-owned: one the public file lacks is never filled from dash (that would publish a private name).
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(theirs)) {
      if (PUBLIC_IDENTITY_KEYS.includes(key)) merged[key] = theirs[key];
      else if (key in ours) merged[key] = ours[key];
    }
    for (const key of Object.keys(ours)) if (!(key in merged) && !PUBLIC_IDENTITY_KEYS.includes(key)) merged[key] = ours[key];
    pkg.bytes = new TextEncoder().encode(JSON.stringify(merged, null, 2) + "\n");
  }

  const deny = await loadDenyPatterns(repo);
  // Paths are scanned as well as contents; binary files are decoded as latin1 so ASCII identifiers inside them still match.
  const hits = [...files].flatMap(([path, file]) => [
    ...(deny.some(p => p.test(path)) ? [`${path}:path`] : []),
    ...denyHits(path, new TextDecoder(file.bytes.includes(0) ? "latin1" : "utf-8").decode(file.bytes), deny),
  ]);
  if (hits.length) throw new Error(`private identifiers in export (strip them in dash first): ${hits.join(", ")}`);
  // gitleaks scans a staged copy of exactly the exported bytes; the target is only written once that is clean.
  const staging = await mkdtemp(join(tmpdir(), "dash-export-"));
  try {
    await writeTree(staging, files);
    const scan = Bun.spawnSync(["gitleaks", "dir", "--no-banner", "--redact", "--exit-code", "1", staging], { stdout: "pipe", stderr: "pipe" });
    if (scan.exitCode !== 0) throw new Error(`gitleaks blocked the export (exit ${scan.exitCode}); run \`gitleaks dir --redact\` on an export for details`);
  } finally { await rm(staging, { recursive: true, force: true }); }
  if (args.dryRun) return [...files.keys()];

  const existing = git(target, ["ls-files", "-z", "--", ...EXPORT_PATHS]).toString().split("\0").filter(Boolean);
  for (const path of existing) if (!files.has(path)) await rm(join(target, path), { force: true });
  await writeTree(target, files);
  return git(target, ["status", "--porcelain"]).toString().split("\n").filter(Boolean);
}

async function writeTree(root: string, files: Map<string, { bytes: Uint8Array; mode: string }>) {
  for (const [path, file] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await rm(join(root, path), { force: true });
    await writeFile(join(root, path), file.bytes);
    await chmod(join(root, path), file.mode === "100755" ? 0o755 : 0o644);
  }
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2)), changed = await exportPublic(args);
    console.log(args.dryRun ? `Would export ${changed.length} files; no private identifiers found.` : changed.length
      ? `Exported. Changed in target:\n${changed.join("\n")}\nUpdate the public README.md and docs/runbook.md for new features, then open a PR.` : "Exported; target unchanged.");
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

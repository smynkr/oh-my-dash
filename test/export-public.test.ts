import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportPublic, parseArgs } from "../scripts/export-public.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString();
};
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "export-test-")); dirs.push(dir);
  git(dir, "init", "-q");
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), text); }
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "init");
  return dir;
}
const pkg = (extra: Record<string, unknown>) => JSON.stringify({ name: "x", private: true, type: "module", ...extra }, null, 2) + "\n";

test("exports code paths, keeps the public identity and public-owned docs, and deletes files removed in dash", async () => {
  const dash = await repo({ ".export-deny": "secret-host\n", "src/a.ts": "export const a = 1;\n", "docs/spec/private.md": "private\n",
    "README.md": "dash readme\n", "package.json": pkg({ name: "dash-private", repository: "private/dash", dependencies: { y: "1" } }) });
  const omd = await repo({ "src/a.ts": "old\n", "src/gone.ts": "stale\n", "README.md": "public readme\n", "LICENSE": "MIT\n",
    "package.json": pkg({ name: "oh-my-dash", license: "MIT", version: "0.1.0" }) });
  const changed = await exportPublic({ ...parseArgs(["--target", omd]), repo: dash });
  expect(await readFile(join(omd, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
  await expect(stat(join(omd, "src/gone.ts"))).rejects.toThrow();
  await expect(stat(join(omd, "docs/spec/private.md"))).rejects.toThrow();
  expect(await readFile(join(omd, "README.md"), "utf8")).toBe("public readme\n");
  const published = JSON.parse(await readFile(join(omd, "package.json"), "utf8"));
  expect([published.name, published.license, published.version, published.dependencies]).toEqual(["oh-my-dash", "MIT", "0.1.0", { y: "1" }]);
  expect(Object.keys(published)).toEqual(["name", "private", "type", "license", "version", "dependencies"]);
  expect(changed.some(line => line.endsWith("src/gone.ts"))).toBe(true);
});

test("a private identifier or tailnet address blocks the export before the target is touched", async () => {
  // The tailnet-range address is assembled at runtime so this file passes its own export check.
  for (const leak of ["const hub = 'Secret-Host.example';\n", `const peer = '${["100", "101", "2", "3"].join(".")}';\n`]) {
    const dash = await repo({ ".export-deny": "# comment\nsecret-host\n", "src/a.ts": leak, "package.json": pkg({}) });
    const omd = await repo({ "src/a.ts": "old\n", "package.json": pkg({ name: "oh-my-dash" }) });
    await expect(exportPublic({ ...parseArgs(["--target", omd]), repo: dash })).rejects.toThrow("src/a.ts:1");
    expect(await readFile(join(omd, "src/a.ts"), "utf8")).toBe("old\n");
    expect(git(omd, "status", "--porcelain")).toBe("");
  }
});

test("identifiers in binary files or file paths, and target symlinks, block the export", async () => {
  const binary = "\u0000\u0001secret-host\u0000";
  for (const files of [{ "public/logo.bin": binary }, { "src/secret-host.ts": "export {};\n" }]) {
    const dash = await repo({ ".export-deny": "secret-host\n", "package.json": pkg({}), ...files });
    const omd = await repo({ "src/a.ts": "old\n", "package.json": pkg({ name: "oh-my-dash" }) });
    await expect(exportPublic({ ...parseArgs(["--target", omd]), repo: dash })).rejects.toThrow("private identifiers");
    expect(git(omd, "status", "--porcelain")).toBe("");
  }
  const dash = await repo({ ".export-deny": "secret-host\n", "src/a.ts": "new\n", "package.json": pkg({}) });
  const omd = await repo({ "src/b.ts": "old\n", "package.json": pkg({ name: "oh-my-dash" }) });
  await symlink("/etc/hosts", join(omd, "src/a.ts")); git(omd, "add", "-A"); git(omd, "commit", "-qm", "link");
  await expect(exportPublic({ ...parseArgs(["--target", omd]), repo: dash })).rejects.toThrow("symlinks under export paths: src/a.ts");
});

test("a gitleaks finding blocks the export and a dirty target is refused", async () => {
  // Synthetic credential assembled at runtime so this file never holds a literal secret.
  const key = ["AKIA", "Q3EGOVFTXYZ7ABCD"].join(""), secret = ["wJalrXUtnFEMI", "K7MDENGbPxRfiCYEXAMPLEKEYzz"].join("/");
  const dash = await repo({ ".export-deny": "secret-host\n", "src/a.ts": `export const aws = { id: "${key}", secret: "${secret}" };\n`, "package.json": pkg({}) });
  const omd = await repo({ "src/a.ts": "old\n", "package.json": pkg({ name: "oh-my-dash" }) });
  await expect(exportPublic({ ...parseArgs(["--target", omd]), repo: dash })).rejects.toThrow("gitleaks blocked");
  expect(await readFile(join(omd, "src/a.ts"), "utf8")).toBe("old\n");
  await writeFile(join(omd, "stray.txt"), "x");
  await expect(exportPublic({ ...parseArgs(["--target", omd]), repo: dash })).rejects.toThrow("not clean");
});

test("dry run reports files without writing, and arguments are validated", async () => {
  const dash = await repo({ ".export-deny": "secret-host\n", "src/a.ts": "new\n", "package.json": pkg({}) });
  const omd = await repo({ "src/a.ts": "old\n", "package.json": pkg({ name: "oh-my-dash" }) });
  expect(await exportPublic({ ...parseArgs(["--target", omd, "--dry-run"]), repo: dash })).toEqual(expect.arrayContaining(["src/a.ts", "package.json"]));
  expect(await readFile(join(omd, "src/a.ts"), "utf8")).toBe("old\n");
  expect(() => parseArgs([])).toThrow("--target");
  expect(() => parseArgs(["--target"])).toThrow("requires a value");
  expect(() => parseArgs(["--target", "x", "--bogus"])).toThrow("Unknown option");
});

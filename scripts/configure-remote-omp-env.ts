#!/usr/bin/env bun
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const START = "# >>> dash remote omp >>>";
const END = "# <<< dash remote omp <<<";
const ZSHENV_START = "# >>> dash zshenv.local loader >>>";
const ZSHENV_END = "# <<< dash zshenv.local loader <<<";
const LABEL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type UpdateOptions = { url?: string; host?: string; uninstall?: boolean; zshenv?: string };

function stripManagedBlock(contents: string, start: string, end: string, file: string): string {
  let output = "";
  let inside = false;
  for (const line of contents.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue;
    const value = line.replace(/\r?\n$/, "");
    if (value === start) {
      if (inside) throw new Error(`Nested Dash markers in ${file}`);
      inside = true;
    } else if (value === end) {
      if (!inside) throw new Error(`Unmatched Dash marker end in ${file}`);
      inside = false;
    } else if (!inside) {
      output += line;
    }
  }
  if (inside) throw new Error(`Unclosed Dash marker block in ${file}`);
  return output;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function targetFor(file: string): Promise<{ target: string; mode?: number }> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { target: file };
    throw error;
  }

  let target = file;
  if (info.isSymbolicLink()) {
    try {
      target = await realpath(file);
      const targetInfo = await stat(target);
      return { target, mode: targetInfo.mode & 0o777 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Dangling symlink at ${file}`);
      }
      throw error;
    }
  }

  const targetInfo = await stat(target);
  return { target, mode: targetInfo.mode & 0o777 };
}

export async function updateRemoteOmpEnv(file: string, options: UpdateOptions): Promise<boolean> {
  if (!options.uninstall) {
    if (typeof options.host !== "string" || !LABEL_PATTERN.test(options.host)) {
      throw new Error("--host must match /^[A-Za-z0-9_-]{1,64}$/");
    }
    if (typeof options.url !== "string" || !options.url) throw new Error("--url is required");
  }

  const zshenv = options.zshenv ?? join(homedir(), ".zshenv");
  // Resolve both paths before either write so a dangling symlink cannot leave a partial install.
  const [envLocation, zshenvLocation] = await Promise.all([targetFor(file), targetFor(zshenv)]);
  const envChanged = await updateBlock(file, envLocation, {
    start: START,
    end: END,
    uninstall: options.uninstall ?? false,
    defaultMode: 0o600,
    render: () => `export DASH_URL=${shellQuote(options.url!)}\nexport DASH_HOST=${shellQuote(options.host!)}\n`,
  });
  const zshenvChanged = await updateZshenvLoader(zshenv, zshenvLocation, options.uninstall ?? false);
  return envChanged || zshenvChanged;
}

async function readTarget(target: string): Promise<string | undefined> {
  try { return await readFile(target, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeTarget(target: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temp, contents, { encoding: "utf8", mode, flag: "wx" });
    await chmod(temp, mode);
    await rename(temp, target);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function updateBlock(
  file: string,
  location: { target: string; mode?: number },
  options: { start: string; end: string; uninstall: boolean; defaultMode: number; render: () => string },
): Promise<boolean> {
  const current = await readTarget(location.target);
  if (current === undefined && options.uninstall) return false;

  const original = current ?? "";
  const withoutBlock = stripManagedBlock(original, options.start, options.end, file);
  const updated = options.uninstall
    ? withoutBlock
    : `${withoutBlock}${withoutBlock && !withoutBlock.endsWith("\n") ? "\n" : ""}${options.start}\n${options.render()}${options.end}\n`;
  if (current === updated) return false;

  await writeTarget(location.target, updated, location.mode ?? options.defaultMode);
  return true;
}

function hasZshenvLocalSource(contents: string): boolean {
  return contents.split(/\r?\n/).some((line) =>
    !line.trimStart().startsWith("#") && /(?:source|\.)\s+.*\.zshenv\.local/.test(line),
  );
}

async function updateZshenvLoader(
  file: string,
  location: { target: string; mode?: number },
  uninstall: boolean,
): Promise<boolean> {
  const current = await readTarget(location.target);
  if (current === undefined && uninstall) return false;

  const original = current ?? "";
  const withoutLoader = stripManagedBlock(original, ZSHENV_START, ZSHENV_END, file);
  let updated: string;
  if (uninstall) {
    updated = withoutLoader;
  } else {
    // Includes our own marked loader, making repeated installs a no-op.
    if (hasZshenvLocalSource(original)) return false;
    updated = `${withoutLoader}${withoutLoader && !withoutLoader.endsWith("\n") ? "\n" : ""}${ZSHENV_START}\n[[ -r \"$HOME/.zshenv.local\" ]] && source \"$HOME/.zshenv.local\"\n${ZSHENV_END}\n`;
  }
  if (current === updated) return false;

  await writeTarget(location.target, updated, location.mode ?? 0o644);
  return true;
}

function parseArgs(argv: string[]): { file: string; zshenv: string; url?: string; host?: string; uninstall: boolean } {
  const result: { file: string; zshenv: string; url?: string; host?: string; uninstall: boolean } = {
    file: join(homedir(), ".zshenv.local"),
    zshenv: join(homedir(), ".zshenv"),
    uninstall: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--uninstall") result.uninstall = true;
    else if (argv[i] === "--file") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--file requires a path");
      result.file = value;
    } else if (argv[i] === "--zshenv") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--zshenv requires a path");
      result.zshenv = value;
    } else if (argv[i] === "--url") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--url requires a URL");
      result.url = value;
    } else if (argv[i] === "--host") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--host requires a label");
      result.host = value;
    } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if (result.uninstall && (result.url || result.host)) throw new Error("--uninstall cannot be combined with --url or --host");
  return result;
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    const changed = await updateRemoteOmpEnv(args.file, args);
    console.log(changed
      ? `${args.uninstall ? "Removed" : "Updated"} Dash OMP settings in ${args.file}`
      : `Dash OMP settings already current in ${args.file}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

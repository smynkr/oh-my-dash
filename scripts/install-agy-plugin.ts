#!/usr/bin/env bun
import { chmod, copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface AgyInstallArgs {
  target: string;
  url: string;
  replyBase: string | null;
  host?: string;
  account?: string;
  remoteQuestions: boolean;
  stopWaitSec: number;
  questionTimeoutSec: number;
  uninstall: boolean;
  dryRun: boolean;
}

const HOST_LABEL = /^[A-Za-z0-9_-]{1,64}$/;
const ACCOUNT_LABEL = /^[A-Za-z0-9._ -]{1,64}$/;
const MARKER_FILE = ".dash-managed";

function validHttpUrl(raw: string, flag: string): URL {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${flag} must be a valid http:// or https:// URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${flag} must use http:// or https://`);
  if (parsed.username || parsed.password) throw new Error(`${flag} must not embed credentials`);
  return parsed;
}

export function parseArgs(argv: string[], home = homedir()): AgyInstallArgs {
  let target = join(home, ".gemini", "config", "plugins", "dash");
  let url = "http://127.0.0.1:4777/ingest/agy";
  let replyBase: string | undefined;
  let noReplies = false;
  let host: string | undefined;
  let account: string | undefined;
  let remoteQuestions = false;
  let stopWaitSec = 5;
  let questionTimeoutSec = 120;
  let uninstall = false;
  let dryRun = false;

  const takeValue = (flag: string, idx: number): string => {
    const val = argv[idx];
    if (!val || val.startsWith("--")) throw new Error(`${flag} requires a value`);
    return val;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--uninstall") uninstall = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-replies") noReplies = true;
    else if (arg === "--remote-questions") remoteQuestions = true;
    else if (arg === "--target") target = takeValue(arg, ++i);
    else if (arg === "--url") url = takeValue(arg, ++i);
    else if (arg === "--reply-base") replyBase = takeValue(arg, ++i);
    else if (arg === "--host") {
      host = takeValue(arg, ++i).trim();
      if (!HOST_LABEL.test(host)) throw new Error("--host must match /^[A-Za-z0-9_-]{1,64}$/");
    } else if (arg === "--account") {
      account = takeValue(arg, ++i).trim();
      if (!account || !ACCOUNT_LABEL.test(account)) throw new Error("--account must be 1..64 safe characters");
    } else if (arg === "--stop-wait") {
      const raw = takeValue(arg, ++i);
      const parsed = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 0 || parsed > 55) {
        throw new Error("--stop-wait must be an integer 0..55");
      }
      stopWaitSec = parsed;
    } else if (arg === "--question-timeout-sec") {
      const raw = takeValue(arg, ++i);
      const parsed = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 5 || parsed > 600) {
        throw new Error("--question-timeout-sec must be an integer 5..600");
      }
      questionTimeoutSec = parsed;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const parsedUrl = validHttpUrl(url, "--url");
  let resolvedReplyBase: string | null;
  if (noReplies) {
    resolvedReplyBase = null;
  } else if (replyBase !== undefined) {
    resolvedReplyBase = validHttpUrl(replyBase, "--reply-base").toString().replace(/\/+$/, "");
  } else {
    resolvedReplyBase = parsedUrl.origin;
  }

  return {
    target,
    url: parsedUrl.toString(),
    replyBase: resolvedReplyBase,
    ...(host ? { host } : {}),
    ...(account ? { account } : {}),
    remoteQuestions,
    stopWaitSec,
    questionTimeoutSec,
    uninstall,
    dryRun,
  };
}

async function ensureNoSymlinks(targetDir: string): Promise<void> {
  const parts: string[] = [];
  let current = targetDir;
  while (true) {
    parts.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const p of parts) {
    if (process.platform === "darwin" && (p === "/var" || p === "/tmp" || p === "/etc")) continue;
    try {
      const info = await lstat(p);
      if (info.isSymbolicLink()) throw new Error(`Refusing symlink in target path: ${p}`);
    } catch (err: any) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
  }
}

export function buildHooksManifest(args: AgyInstallArgs) {
  const preToolTimeout = args.remoteQuestions ? Math.max(15, args.questionTimeoutSec + 5) : 15;
  const stopTimeout = args.replyBase ? Math.max(15, args.stopWaitSec + 10) : 15;
  return {
    dash: {
      SessionStart: [{ type: "command", command: "python3 ./dash-agy-hook.py", timeout: 10 }],
      PreInvocation: [{ type: "command", command: "python3 ./dash-agy-hook.py", timeout: 10 }],
      PreToolUse: [
        {
          matcher: "ask_question",
          hooks: [{ type: "command", command: "python3 ./dash-agy-hook.py", timeout: preToolTimeout }],
        },
      ],
      PostToolUse: [
        {
          matcher: "ask_question",
          hooks: [{ type: "command", command: "python3 ./dash-agy-hook.py", timeout: 10 }],
        },
      ],
      Stop: [{ type: "command", command: "python3 ./dash-agy-hook.py", timeout: stopTimeout }],
    },
  };
}

export async function installAgyPlugin(args: AgyInstallArgs): Promise<string> {
  const targetDir = resolve(args.target);
  await ensureNoSymlinks(targetDir);

  const markerPath = join(targetDir, MARKER_FILE);
  if (args.uninstall) {
    let exists = false;
    try { exists = (await lstat(targetDir)).isDirectory(); } catch { exists = false; }
    if (!exists) return args.dryRun ? `Would remove ${targetDir} (not present)` : `Nothing to remove at ${targetDir}`;
    let managed = false;
    try { managed = (await lstat(markerPath)).isFile(); } catch { managed = false; }
    if (!managed) {
      const entries = await readdir(targetDir);
      if (entries.length > 0) throw new Error(`Refusing to uninstall unmanaged non-empty directory: ${targetDir}`);
    }
    if (args.dryRun) return `Would remove ${targetDir}`;
    await rm(targetDir, { recursive: true, force: true });
    return `Removed Antigravity Dash plugin at ${targetDir}`;
  }

  const pluginSourceDir = join(import.meta.dir, "..", "agy-plugin");
  const pluginJsonSource = join(pluginSourceDir, "plugin.json");
  const hookScriptSource = join(pluginSourceDir, "dash-agy-hook.py");
  await stat(pluginJsonSource);
  await stat(hookScriptSource);

  const configPayload = {
    url: args.url,
    repliesEnabled: args.replyBase !== null,
    ...(args.replyBase ? { replyBase: args.replyBase } : {}),
    ...(args.host ? { host: args.host } : {}),
    ...(args.account ? { account: args.account } : {}),
    remoteQuestions: args.remoteQuestions,
    stopWaitSec: args.stopWaitSec,
    questionTimeoutMs: args.questionTimeoutSec * 1000,
  };
  const hooksManifest = buildHooksManifest(args);

  if (args.dryRun) {
    return `Would install Antigravity Dash plugin to ${targetDir} (url=${args.url}, replies=${args.replyBase ?? "off"}, remoteQuestions=${args.remoteQuestions})`;
  }

  let dirExists = false;
  try { dirExists = (await lstat(targetDir)).isDirectory(); } catch { dirExists = false; }
  if (dirExists) {
    let managed = false;
    try { managed = (await lstat(markerPath)).isFile(); } catch { managed = false; }
    if (!managed && (await readdir(targetDir)).length > 0) {
      throw new Error(`Refusing to overwrite unmanaged non-empty directory: ${targetDir}`);
    }
  }
  await mkdir(targetDir, { recursive: true });
  for (const name of ["plugin.json", "hooks.json", "dash-agy-hook.py", "dash-config.json", MARKER_FILE]) {
    const dest = join(targetDir, name);
    try {
      const info = await lstat(dest);
      if (info.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink: ${dest}`);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  await copyFile(pluginJsonSource, join(targetDir, "plugin.json"));
  await copyFile(hookScriptSource, join(targetDir, "dash-agy-hook.py"));
  await chmod(join(targetDir, "dash-agy-hook.py"), 0o755);
  await writeFile(join(targetDir, "hooks.json"), `${JSON.stringify(hooksManifest, null, 2)}\n`, "utf8");
  await writeFile(join(targetDir, "dash-config.json"), `${JSON.stringify(configPayload, null, 2)}\n`, "utf8");
  await writeFile(markerPath, "managed by dash install-agy-plugin\n", "utf8");
  return `Installed Antigravity Dash plugin at ${targetDir}`;
}

if (import.meta.main) {
  try {
    console.log(await installAgyPlugin(parseArgs(Bun.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

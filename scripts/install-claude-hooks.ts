#!/usr/bin/env bun
import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS: Array<[string, string?]> = [
  ["SessionStart"], ["UserPromptSubmit"], ["PreToolUse", "AskUserQuestion"],
  ["PostToolUse", "AskUserQuestion"], ["PermissionRequest"], ["Notification"],
  ["Stop"], ["StopFailure"], ["SessionEnd"],
];
const URL_RE = /^https?:\/\/[A-Za-z0-9._:[\]%-]+(?::\d+)?(?:\/[A-Za-z0-9._~:/?#[\]@!&*+,=%-]*)?$/;

type Args = {
  settings: string; url: string; host: string; replyBase: string; replyScript: string;
  questionHelper: string; autopilotDialogHelper: string; autopilotFenceHelper: string; python3: string; questionTimeoutMs: number;
  remoteQuestions: boolean; autopilotDialogs: boolean; autopilotFence: boolean;
  noReply: boolean; dryRun: boolean; uninstall: boolean;
};

export function parseArgs(argv: string[]): Args {
  const result: Args = {
    settings: join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".claude", "settings.json"),
    url: "http://127.0.0.1:4777/ingest/claude",
    host: hostname().split(".")[0] || "localhost",
    replyBase: "",
    replyScript: join(homedir(), ".local/share/dash/scripts/reply-wait.sh"),
    questionHelper: join(homedir(), ".local/share/dash/scripts/claude-question.py"),
    autopilotDialogHelper: join(homedir(), ".local/share/dash/scripts/claude-autopilot-dialog.py"),
    autopilotFenceHelper: join(homedir(), ".local/share/dash/scripts/claude-autopilot-fence.py"),
    python3: "/usr/bin/python3",
    questionTimeoutMs: 120_000,
    remoteQuestions: false,
    autopilotDialogs: false,
    autopilotFence: false,
    noReply: false,
    dryRun: false,
    uninstall: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") result.dryRun = true;
    else if (flag === "--uninstall") result.uninstall = true;
    else if (flag === "--no-reply") result.noReply = true;
    else if (flag === "--remote-questions") result.remoteQuestions = true;
    else if (flag === "--autopilot-dialogs") result.autopilotDialogs = true;
    else if (flag === "--autopilot") result.autopilotFence = true;
    else if (["--settings", "--url", "--host", "--reply-base", "--reply-script",
      "--question-helper", "--autopilot-dialog-helper", "--autopilot-fence-helper", "--python3", "--question-timeout-ms"].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--settings") result.settings = value;
      if (flag === "--url") result.url = value;
      if (flag === "--host") result.host = value.split(".")[0];
      if (flag === "--reply-base") result.replyBase = value;
      if (flag === "--reply-script") result.replyScript = value;
      if (flag === "--question-helper") result.questionHelper = value;
      if (flag === "--autopilot-dialog-helper") result.autopilotDialogHelper = value;
      if (flag === "--autopilot-fence-helper") result.autopilotFenceHelper = value;
      if (flag === "--python3") result.python3 = value;
      if (flag === "--question-timeout-ms") {
        if (!/^\d+$/.test(value)) throw new Error("--question-timeout-ms must be an integer");
        result.questionTimeoutMs = Number(value);
      }
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (result.autopilotDialogs && result.remoteQuestions)
    throw new Error("--autopilot-dialogs cannot be combined with --remote-questions");
  if (result.autopilotDialogs) result.autopilotFence = true;
  if (!URL_RE.test(result.url)) {
    throw new Error("--url must be an http(s) URL without shell-sensitive characters");
  }
  if (!result.replyBase) result.replyBase = new URL(result.url).origin;
  if (!URL_RE.test(result.replyBase)) throw new Error("--reply-base must be an http(s) URL without shell-sensitive characters");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(result.host)) throw new Error("--host must be a short alphanumeric host label");
  if (!isAbsolute(result.replyScript)) throw new Error("--reply-script must be an absolute path");
  if (!isAbsolute(result.questionHelper)) throw new Error("--question-helper must be an absolute path");
  if (!isAbsolute(result.autopilotDialogHelper)) throw new Error("--autopilot-dialog-helper must be an absolute path");
  if (!isAbsolute(result.autopilotFenceHelper)) throw new Error("--autopilot-fence-helper must be an absolute path");
  if (!isAbsolute(result.python3)) throw new Error("--python3 must be an absolute path");
  if (!Number.isSafeInteger(result.questionTimeoutMs) || result.questionTimeoutMs < 1000 || result.questionTimeoutMs > 600_000)
    throw new Error("--question-timeout-ms must be between 1000 and 600000");
  return result;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function dashGroups(options: Pick<Args, "url" | "host" | "replyBase" | "replyScript" | "noReply" |
  "remoteQuestions" | "autopilotDialogs" | "autopilotFence" | "questionTimeoutMs" | "questionHelper" |
  "autopilotDialogHelper" | "autopilotFenceHelper" | "python3">) {
  const { url, host } = options;
  const command = `curl -s -m 3 -o /dev/null -X POST -H 'Content-Type: application/json' -H 'X-Dash-Host: ${host}' -H "X-Dash-Account-Alias: \${DASH_ACCOUNT_ALIAS:-}" -H "X-Dash-Entrypoint: \${CLAUDE_CODE_ENTRYPOINT:-}" -H "X-Dash-Attended: \${CLAUDE_CODE_SESSION_ATTENDED:-}" -H "X-Dash-Kind: \${CLAUDE_CODE_SESSION_KIND:-}" --data-binary @- ${shellQuote(url)} >/dev/null 2>&1; true # dash-hook`;
  return EVENTS.flatMap(([event, matcher]) => {
    const groups: Array<readonly [string, unknown]> = [[event, { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", async: true, timeout: 5, command }] }]];
    if (event === "PreToolUse" && options.autopilotFence) {
      const fenceCommand = `${shellQuote(options.python3)} ${shellQuote(options.autopilotFenceHelper)} --hub-url ${shellQuote(options.replyBase)} --host ${shellQuote(host)} # dash-hook-autopilot-fence`;
      groups.push([event, {
        matcher: ".*",
        hooks: [{ type: "command", timeout: 5, command: fenceCommand }],
      }]);
    }
    if (event === "PreToolUse" && options.autopilotDialogs) {
      const dialogCommand = `${shellQuote(options.python3)} ${shellQuote(options.autopilotDialogHelper)} --hub-url ${shellQuote(options.replyBase)} --host ${shellQuote(host)} # dash-hook-autopilot-dialog`;
      groups.push([event, { matcher: "AskUserQuestion", hooks: [{ type: "command", timeout: 605, command: dialogCommand }] }]);
    } else if (event === "PreToolUse" && options.remoteQuestions) {
      const timeoutSeconds = Math.ceil(options.questionTimeoutMs / 1000) + 5;
      const questionCommand = `${shellQuote(options.python3)} ${shellQuote(options.questionHelper)} --hub-url ${shellQuote(options.replyBase)} --host ${shellQuote(host)} --timeout-ms ${shellQuote(String(options.questionTimeoutMs))} # dash-hook-question`;
      groups.push([event, { matcher: "AskUserQuestion", hooks: [{ type: "command", timeout: timeoutSeconds, command: questionCommand }] }]);
    }
    if (event === "Stop" && !options.noReply) {
      const pythonArgument = ` ${shellQuote(options.python3)}`;
      groups.push([event, { hooks: [{
        type: "command", async: true, asyncRewake: true, timeout: 21600,
        command: `/bin/sh ${shellQuote(options.replyScript)} ${shellQuote(options.replyBase)} ${shellQuote(host)}${pythonArgument} # dash-hook`,
      }] }]);
    }
    return groups;
  });
}

export function mergeSettings(input: unknown, options: Pick<Args, "url" | "host" | "replyBase" | "replyScript" | "noReply" |
  "remoteQuestions" | "autopilotDialogs" | "autopilotFence" | "questionTimeoutMs" | "questionHelper" |
  "autopilotDialogHelper" | "autopilotFenceHelper" | "python3" | "uninstall">): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("settings JSON must be an object");
  const doc = structuredClone(input) as Record<string, unknown>;
  if (doc.hooks === undefined) {
    if (options.uninstall) return doc;
    doc.hooks = {};
  }
  if (doc.hooks === null || typeof doc.hooks !== "object" || Array.isArray(doc.hooks)) throw new Error("settings hooks must be an object");
  const hooks = doc.hooks as Record<string, unknown>;
  const preexistingEmptyArrays = new Set(Object.entries(hooks).filter(([, value]) => Array.isArray(value) && value.length === 0).map(([event]) => event));
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    hooks[event] = value.flatMap((group) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return [group];
      const item = group as Record<string, unknown>;
      if (!Array.isArray(item.hooks)) return [group];
      const retained = item.hooks.filter((hook) => !(hook && typeof hook === "object" && !Array.isArray(hook) && typeof (hook as Record<string, unknown>).command === "string" && ((hook as Record<string, unknown>).command as string).includes("# dash-hook")));
      return retained.length ? [{ ...item, hooks: retained }] : [];
    });
  }
  if (!options.uninstall) {
    for (const [event, group] of dashGroups(options)) {
      if (!Array.isArray(hooks[event])) hooks[event] = [];
      (hooks[event] as unknown[]).push(group);
    }
  }
  for (const [event, value] of Object.entries(hooks)) if (Array.isArray(value) && value.length === 0 && !preexistingEmptyArrays.has(event)) delete hooks[event];
  if (options.uninstall && Object.keys(hooks).length === 0) delete doc.hooks;
  return doc;
}

async function backupPath(path: string): Promise<string> {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  let candidate = `${path}.bak-dash-${stamp}`;
  let suffix = 1;
  while (await Bun.file(candidate).exists()) candidate = `${path}.bak-dash-${stamp}-${suffix++}`;
  return candidate;
}

const questionHelperSource = fileURLToPath(new URL("./claude-question.py",import.meta.url));
const questionHelperMarker = "Synchronous Claude PreToolUse bridge";

function hasQuestionHook(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const hooks = (input as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const preToolUse = (hooks as Record<string, unknown>).PreToolUse;
  if (!Array.isArray(preToolUse)) return false;
  return preToolUse.some(group => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return false;
    const entries = (group as Record<string, unknown>).hooks;
    return Array.isArray(entries) && entries.some(hook => {
      if (!hook || typeof hook !== "object" || Array.isArray(hook)) return false;
      const command = (hook as Record<string, unknown>).command;
      return typeof command === "string" && command.includes("# dash-hook-question");
    });
  });
}
function hasAutopilotDialogHook(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const hooks = (input as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const preToolUse = (hooks as Record<string, unknown>).PreToolUse;
  if (!Array.isArray(preToolUse)) return false;
  return preToolUse.some(group => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return false;
    const entries = (group as Record<string, unknown>).hooks;
    return Array.isArray(entries) && entries.some(hook => {
      if (!hook || typeof hook !== "object" || Array.isArray(hook)) return false;
      const command = (hook as Record<string, unknown>).command;
      return typeof command === "string" && command.includes("# dash-hook-autopilot-dialog");
    });
  });
}

const autopilotDialogHelperSource = fileURLToPath(new URL("./claude-autopilot-dialog.py", import.meta.url));
const autopilotDialogHelperMarker = "Synchronous Claude goal-aware AskUserQuestion hook";

const autopilotFenceHelperSource = fileURLToPath(new URL("./claude-autopilot-fence.py", import.meta.url));
const autopilotFenceHelperMarker = "Synchronous Claude PreToolUse deny-fence hook";
const autopilotCacheSource = fileURLToPath(new URL("./autopilot_fence_cache.py", import.meta.url));
const autopilotCacheMarker = "Private per-session autopilot fence cache shared by Claude hooks.";

function hasAutopilotFenceHook(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const hooks = (input as Record<string, unknown>).hooks;
  const preToolUse = hooks && typeof hooks === "object" && !Array.isArray(hooks)
    ? (hooks as Record<string, unknown>).PreToolUse : undefined;
  return Array.isArray(preToolUse) && preToolUse.some(group => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return false;
    const entries = (group as Record<string, unknown>).hooks;
    return Array.isArray(entries) && entries.some(hook =>
      !!hook && typeof hook === "object" && !Array.isArray(hook) &&
      typeof (hook as Record<string, unknown>).command === "string" &&
      ((hook as Record<string, unknown>).command as string).includes("# dash-hook-autopilot-fence"));
  });
}

async function installManagedHelper(path: string, source: string, marker: string, label: string): Promise<void> {
  try { if (await realpath(path) === await realpath(source)) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let current: string | undefined;
  try { current = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (current !== undefined && !current.includes(marker))
    throw new Error(`Refusing to overwrite a non-Dash ${label}: ${path}`);
  const temp = join(dirname(path), `.${process.pid}.${Date.now()}.${label.replaceAll(" ", "-")}.tmp`);
  try {
    await copyFile(source, temp);
    await chmod(temp, 0o700);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function removeManagedHelper(path: string, source: string, marker: string): Promise<void> {
  try { if (await realpath(path) === await realpath(source)) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let current: string;
  try { current = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (current.includes(marker)) await unlink(path);
}

async function isQuestionHelperSource(path: string): Promise<boolean> {
  try { return await realpath(path) === await realpath(questionHelperSource); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function installQuestionHelper(path: string): Promise<void> {
  if (await isQuestionHelperSource(path)) return;
  await mkdir(dirname(path),{ recursive:true,mode:0o700 });
  let current: string | undefined;
  try { current = await readFile(path,"utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (current !== undefined && !current.includes(questionHelperMarker))
    throw new Error(`Refusing to overwrite a non-Dash Claude question helper: ${path}`);
  const temp = join(dirname(path),`.${process.pid}.${Date.now()}.claude-question.tmp`);
  try {
    await copyFile(questionHelperSource,temp);
    await chmod(temp,0o700);
    await rename(temp,path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}
async function removeQuestionHelper(path: string): Promise<void> {
  if (await isQuestionHelperSource(path)) return;
  let current: string;
  try { current = await readFile(path,"utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (current.includes(questionHelperMarker)) await unlink(path);
}
export async function updateSettings(args: Args): Promise<{ output: string; changed: boolean; backup?: string }> {
  const target = await realpath(args.settings);
  const originalStat = await stat(target);
  const original = await readFile(target, "utf8");
  const parsed = JSON.parse(original) as unknown;
  const merged = mergeSettings(parsed, args);
  const output = `${JSON.stringify(merged, null, 2)}\n`;
  JSON.parse(output);
  const changed = output !== `${JSON.stringify(parsed, null, 2)}\n`;
  const removeHelper = hasQuestionHook(parsed) && (args.uninstall || !args.remoteQuestions);
  const removeDialogHelper = hasAutopilotDialogHook(parsed) && (args.uninstall || !args.autopilotDialogs);
  const removeFenceHelper = hasAutopilotFenceHook(parsed) && (args.uninstall || !args.autopilotFence);
  const removeCache = (removeDialogHelper || removeFenceHelper) && (args.uninstall || (!args.autopilotDialogs && !args.autopilotFence));
  const cacheDirectories = new Set([dirname(args.replyScript),dirname(args.autopilotDialogHelper),dirname(args.autopilotFenceHelper)]);
  if (args.dryRun) return { output, changed };
  if (!args.uninstall && args.remoteQuestions) await installQuestionHelper(args.questionHelper);
  if (!args.uninstall && args.autopilotDialogs)
    await installManagedHelper(args.autopilotDialogHelper,autopilotDialogHelperSource,autopilotDialogHelperMarker,"Claude dialog helper");
  if (!args.uninstall && args.autopilotFence)
    await installManagedHelper(args.autopilotFenceHelper,autopilotFenceHelperSource,autopilotFenceHelperMarker,"Claude deny-fence helper");
  if (!args.uninstall && (args.autopilotDialogs || args.autopilotFence)) for (const directory of cacheDirectories)
    await installManagedHelper(join(directory,"autopilot_fence_cache.py"),autopilotCacheSource,autopilotCacheMarker,"autopilot fence cache");
  if (!changed) {
    if (removeHelper) await removeQuestionHelper(args.questionHelper);
    if (removeDialogHelper) await removeManagedHelper(args.autopilotDialogHelper,autopilotDialogHelperSource,autopilotDialogHelperMarker);
    if (removeFenceHelper) await removeManagedHelper(args.autopilotFenceHelper,autopilotFenceHelperSource,autopilotFenceHelperMarker);
    if (removeCache) for (const directory of cacheDirectories)
      await removeManagedHelper(join(directory,"autopilot_fence_cache.py"),autopilotCacheSource,autopilotCacheMarker);
    return { output, changed };
  }
  const backup = await backupPath(target);
  await copyFile(target, backup);
  const temp = join(dirname(target), `.${process.pid}.${Date.now()}.dash-settings.tmp`);
  try {
    await writeFile(temp, output, { encoding: "utf8", mode: originalStat.mode & 0o7777 });
    await chmod(temp, originalStat.mode & 0o7777);
    JSON.parse(await readFile(temp, "utf8"));
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  if (removeHelper) await removeQuestionHelper(args.questionHelper);
  if (removeDialogHelper) await removeManagedHelper(args.autopilotDialogHelper,autopilotDialogHelperSource,autopilotDialogHelperMarker);
  if (removeFenceHelper) await removeManagedHelper(args.autopilotFenceHelper,autopilotFenceHelperSource,autopilotFenceHelperMarker);
  if (removeCache) for (const directory of cacheDirectories)
    await removeManagedHelper(join(directory,"autopilot_fence_cache.py"),autopilotCacheSource,autopilotCacheMarker);
  return { output, changed, backup };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    const result = await updateSettings(args);
    if (args.dryRun) {
      const count = result.output.match(/# dash-hook/g)?.length ?? 0;
      console.log(`${args.uninstall ? "Would uninstall" : "Would install"}: ${count} dash hook entries; ${result.changed ? "settings would change" : "no change"}.`);
    } else if (result.changed) console.log(`${args.uninstall ? "Uninstalled" : "Installed"} dash hooks. Backup: ${result.backup}`);
    else console.log("Settings already up to date; no changes made.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

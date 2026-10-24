import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

type Profile = {
  threadId?: string;
  threadIds?: string[];
  title?: string;
  cwd?: string;
  turns?: unknown[];
  turnsByThread?: Record<string, unknown[]>;
  turnsFile?: string;
  turnsDelayMs?: number;
  loadedThreadsDelayMs?: number;
  turnAfterStart?: unknown;
  threadMetadataFile?: string;
  threadListMetadataFile?: string;
  threadReadMetadataFile?: string;
  version?: string;
};
type FixtureConfig = {
  profiles?: Record<string, Profile>;
  unsupportedMethods?: string[];
  unsupportedOnceMethods?: string[];
  loadedThreads?: string[];
  failRequests?: string[];
  failOnceMethods?: string[];
  failRequestMessages?: Record<string, string>;
  timeoutMethods?: string[];
  exitMethods?: string[];
  crashFirstLaunch?: boolean;
  crashDelayMs?: number;
  failAfterInitialSync?: string[];
};

const codeHome = process.env.CODEX_HOME;
if (!codeHome) throw new Error("fake app-server requires a test CODEX_HOME");
const config = JSON.parse(process.argv[2] ?? "{}") as FixtureConfig;
const profile = config.profiles?.[basename(codeHome)] ?? {};
const threadId = profile.threadId ?? "fake_thread";
const threadIds = profile.threadIds ?? [threadId];
const thread = {
  id: threadId,
  name: profile.title ?? `Fake ${basename(codeHome)}`,
  cwd: profile.cwd ?? `/tmp/${basename(codeHome)}`,
  source: "vscode",
  status: { type: "active" },
  updatedAt: 1_800_000_000,
};
const loadedThreads = new Set(config.loadedThreads ?? [threadId]);
const failAfterInitialSync = new Set(config.failAfterInitialSync ?? []);
const failOnceMethods = new Set(config.failOnceMethods ?? []);
const unsupportedOnceMethods = new Set(config.unsupportedOnceMethods ?? []);
let initialSyncComplete = false;
function currentThread(kind: "list" | "read" = "list", id = threadId): Record<string, unknown> {
  const index = Math.max(0, threadIds.indexOf(id));
  const base = { ...thread, id, updatedAt: thread.updatedAt + index,
    ...(index ? { name: `${thread.name} ${index}` } : {}) };
  const path = kind === "list"
    ? profile.threadListMetadataFile ?? profile.threadMetadataFile
    : profile.threadReadMetadataFile ?? profile.threadMetadataFile;
  if (!path || !existsSync(path)) return base;
  return { ...base, ...(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) };
}
const rpcLogPath = join(codeHome, "fake-app-server-rpc.jsonl");
const launchCountPath = join(codeHome, "fake-app-server-launches");
const launchCount = existsSync(launchCountPath) ? Number(readFileSync(launchCountPath, "utf8")) + 1 : 1;
writeFileSync(launchCountPath, String(launchCount));

function respond(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  let request: Record<string, unknown>;
  try { request = JSON.parse(line) as Record<string, unknown>; } catch { return; }
  const method = typeof request.method === "string" ? request.method : undefined;
  if (!method) return;
  appendFileSync(rpcLogPath, `${JSON.stringify(request)}\n`);
  if (request.id === undefined) return;

  const id = request.id as number | string;
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params as Record<string, unknown> : {};
  if (config.exitMethods?.includes(method)) {
    process.exit(73);
    return;
  }
  if (config.timeoutMethods?.includes(method)) return;
  if (failOnceMethods.delete(method) || config.failRequests?.includes(method) || (initialSyncComplete && failAfterInitialSync.delete(method))) {
    respond({ id, error: { code: -32000, message: config.failRequestMessages?.[method] ?? `Synthetic fixture failure: ${method}` } });
    return;
  }

  if (config.unsupportedMethods?.includes(method) || unsupportedOnceMethods.delete(method)) {
    respond({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    return;
  }

  let result: unknown;
  switch (method) {
    case "initialize":
      result = { userAgent: profile.version ?? "codex-cli/0.160.0" };
      respond({ id, result });
      if (config.crashFirstLaunch && launchCount === 1) {
        // This timer runs in a real child process; parent-side fake timers cannot trigger the crash.
        setTimeout(() => process.exit(73), config.crashDelayMs ?? 150);
      }
      return;
    case "thread/list":
      result = { data: params.archived === true ? [] : threadIds.map(id => currentThread("list", id)) };
      break;
    case "thread/loaded/list": {
      const loadedResult = { data: [...loadedThreads] };
      if (initialSyncComplete && profile.loadedThreadsDelayMs) {
        setTimeout(() => respond({ id, result: loadedResult }), profile.loadedThreadsDelayMs);
        return;
      }
      result = loadedResult;
      break;
    }
    case "thread/read":
      result = { thread: currentThread("read", typeof params.threadId === "string" ? params.threadId : threadId) };
      break;
    case "thread/resume":
      loadedThreads.add(typeof params.threadId === "string" ? params.threadId : threadId);
      result = { thread: currentThread("read", typeof params.threadId === "string" ? params.threadId : threadId) };
      break;
    case "thread/turns/list":
      result = { data: profile.turnsFile ? JSON.parse(readFileSync(profile.turnsFile, "utf8")) :
        profile.turnsByThread?.[String(params.threadId)] ?? profile.turns ?? [] };
      initialSyncComplete = true;
      if (profile.turnsDelayMs) {
        setTimeout(() => respond({ id, result }), profile.turnsDelayMs);
        return;
      }
      break;
    case "turn/start":
      if (profile.turnAfterStart && profile.turnsFile) writeFileSync(profile.turnsFile, JSON.stringify([profile.turnAfterStart]));
      result = {};
      break;
    case "turn/steer":
    case "turn/interrupt":
      result = {};
      break;
    default:
      respond({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
  }
  respond({ id, result });
});
lines.on("close", () => process.exit(0));

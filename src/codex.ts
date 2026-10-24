import { createHash, randomBytes } from "node:crypto";
import { spawn, type SpawnOptions } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { homedir, hostname as osHostname } from "node:os";
import { basename, dirname, isAbsolute, resolve, join } from "node:path";
import type { LivenessRecord } from "./liveness.ts";

export interface CodexIdentityConfig { accountAlias?: string; codeHome: string }
export interface CodexControlMessage {
  id: number;
  target: string;
  action: CodexAction;
  text?: string;
  expectedTurnId?: string;
}
export interface CodexAdapterOptions {
  host: string;
  identities: readonly CodexIdentityConfig[];
  hubUrl?: string;
  forwardEvents?: boolean;
  repliesEnabled?: boolean;
  command?: string;
  args?: string[];
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  restartDelayMs?: number;
  onEvent: (event: NormalizedEvent) => void | Promise<void>;
  onLiveness: (records: LivenessRecord[]) => void | Promise<void>;
  onError?: (area: string, code: string) => void;
}
export interface CodexIdentityHealth {
  accountAlias: string | null;
  state: "starting" | "ready" | "offline";
  loaded: number;
  version: string | null;
}
export interface CodexAdapterHealth { enabled: boolean; identities: CodexIdentityHealth[] }
export interface CodexAdapter {
  start(): CodexAdapter;
  waitForReady(timeoutMs?: number): Promise<void>;
  health(): CodexAdapterHealth;
  close(): void;
}

const hostPattern = /^[A-Za-z0-9_-]{1,64}$/;
const threadIdPattern = /^[A-Za-z0-9_-]{1,96}$/;
const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const textLimit = 100 * 1024;
const detailLimit = 4 * 1024;
const pageLimit = 100;
const turnStartClockSkewMs = 5_000;
const maxThreadPages = 100;
const sessionKey = (host: string, sessionId: string) => `${host}|codex|${sessionId}`;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const shortText = (value: unknown, limit: number) => {
  const text = string(value);
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= limit) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
};
const asSeconds = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value * 1000) : undefined;
const stableTag = (alias?: string) => createHash("sha256").update((alias ?? "unassigned").trim().toLowerCase()).digest("hex").slice(0, 12);
function canonicalCodeHome(path: string): string {
  const absolute = resolve(path);
  try {
    if (!statSync(absolute).isDirectory()) throw new Error("Each Codex codeHome must be a directory");
  } catch (error) {
    const code = record(error)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  let candidate = absolute;
  const suffix: string[] = [];
  while (true) {
    try { return resolve(realpathSync(candidate), ...suffix.reverse()); }
    catch (error) {
      const code = record(error)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

const sessionIdForThread = (identity: CodexIdentityConfig, threadId: string) =>
  threadIdPattern.test(threadId) ? `c_${stableTag(identity.accountAlias)}_${threadId}` : undefined;

export function codexHostFromEnv(env: NodeJS.ProcessEnv = process.env, hostName = osHostname()): string {
  const override = env.DASH_HOST?.trim();
  const fallback = hostName.split(".")[0] || "localhost";
  const host = override || fallback;
  if (!hostPattern.test(host)) throw new Error("DASH_HOST must be a 1-64 character Codex host label");
  return host;
}

export function codexIdentitiesFromEnv(env: NodeJS.ProcessEnv = process.env): CodexIdentityConfig[] {
  const defaultHome = env.CODEX_HOME?.trim() || join(env.HOME || homedir(), ".codex");
  const raw = env.DASH_CODEX_IDENTITIES;
  const explicitProfiles = raw !== undefined && raw.trim() !== "";
  let entries: unknown[];
  if (!explicitProfiles) {
    entries = [{ accountAlias: env.DASH_ACCOUNT_ALIAS, codeHome: defaultHome }];
  } else {
    let parsed: unknown;
    try { parsed = JSON.parse(raw!); } catch { throw new Error("DASH_CODEX_IDENTITIES must be valid JSON"); }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16) {
      throw new Error("DASH_CODEX_IDENTITIES must be an array of 1-16 local profiles");
    }
    entries = parsed;
  }
  const identities: CodexIdentityConfig[] = [];
  const aliases = new Set<string>(), homes = new Set<string>();
  for (const entry of entries) {
    const item = record(entry);
    if (!item || Object.keys(item).some(key => key !== "accountAlias" && key !== "codeHome")) {
      throw new Error("Each Codex identity may only define accountAlias and codeHome");
    }
    const rawAlias = item.accountAlias;
    const accountAlias = typeof rawAlias === "string" ? rawAlias.trim() : undefined;
    if (accountAlias && (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(accountAlias))) {
      throw new Error("Codex accountAlias must be a non-secret display label of at most 64 characters");
    }
    if (rawAlias !== undefined && rawAlias !== null && typeof rawAlias !== "string") {
      throw new Error("Codex accountAlias must be a string");
    }
    if (explicitProfiles && (typeof item.codeHome !== "string" || !item.codeHome.trim())) {
      throw new Error("Each explicit Codex identity requires its own codeHome");
    }
    const codeHome = typeof item.codeHome === "string" && item.codeHome.trim() ? item.codeHome.trim() : defaultHome;
    if (!isAbsolute(codeHome)) throw new Error("Each Codex codeHome must be an absolute local path");
    const homeKey = canonicalCodeHome(codeHome);
    const aliasKey = (accountAlias ?? "unassigned").toLowerCase();
    if (aliases.has(aliasKey) || homes.has(homeKey)) throw new Error("Codex identities must have unique account aliases and CODEX_HOME paths");
    aliases.add(aliasKey); homes.add(homeKey);
    identities.push({ ...(accountAlias ? { accountAlias } : {}), codeHome: homeKey });
  }
  if (identities.length > 1 && identities.some(identity => !identity.accountAlias)) {
    throw new Error("Multiple Codex identities require a distinct accountAlias for each profile");
  }
  return identities;
}

export class CodexRpcError extends Error {
  constructor(readonly code: number | undefined, message = "Codex app-server request failed", readonly method?: string) {
    super(message.slice(0, 512));
    this.name = "CodexRpcError";
  }
}
class CodexRpcUnknownError extends Error {
  constructor(readonly method: string, readonly reason: "request_timeout" | "request_interrupted", message: string) {
    super(message.slice(0, 512));
    this.name = "CodexRpcUnknownError";
  }
}
class CodexRpcTimeoutError extends CodexRpcUnknownError {
  constructor(method: string) {
    super(method, "request_timeout", "Codex app-server request timed out");
    this.name = "CodexRpcTimeoutError";
  }
}

type RpcId = number | string;
type PendingRpc = { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type CodexControlDispatchResult =
  | { outcome: "accepted" | "unsupported" | "failed"; reason?: string }
  | { outcome: "unknown"; reason: "request_timeout" | "request_interrupted" };
type TurnStartReservation = { baselineTurnIds: Set<string> | null; prompt: string; requestedAt: number };
type AppServerNotification = (method: string, params: Record<string, unknown>) => void;
type AppServerRequest = (method: string, params: Record<string, unknown>) => void;

function safeChildEnvironment(identity: CodexIdentityConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SystemRoot"] as const) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  env.CODEX_HOME = identity.codeHome;
  return env;
}

class CodexAppServer {
  private child?: ReturnType<typeof spawn>;
  private lines?: ReadLineInterface;
  private nextId = 0;
  private pending = new Map<string, PendingRpc>();
  private exitResolve!: () => void;
  private exitPromise = new Promise<void>(resolve => { this.exitResolve = resolve; });
  private exited = false;
  private closing = false;
  private protocolError?: Error;
  userAgent = "";

  constructor(private readonly options: {
    command: string; args: string[]; identity: CodexIdentityConfig; spawnImpl: typeof spawn;
    timeoutMs: number; onNotification: AppServerNotification; onServerRequest: AppServerRequest;
    onError?: (code: string) => void;
  }) {}

  async start(): Promise<void> {
    const childOptions: SpawnOptions = { env: safeChildEnvironment(this.options.identity), stdio: ["pipe", "pipe", "ignore"] };
    const child = this.options.spawnImpl(this.options.command, this.options.args, childOptions);
    this.child = child;
    if (!child.stdin || !child.stdout) throw new Error("Codex app-server stdio was unavailable");
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", line => this.onLine(line));
    child.stdin.once("error", error => {
      if (this.exited || this.closing) return;
      this.protocolError = new Error("Codex app-server stdin failed");
      this.options.onError?.(processErrorCode(error));
      this.failPending(this.protocolError);
      this.markExited();
      try { child.kill("SIGTERM"); } catch {}
    });
    child.once("error", error => {
      this.protocolError = new Error("Codex app-server process failed");
      this.options.onError?.(processErrorCode(error));
      this.failPending(this.protocolError);
      this.markExited();
    });
    child.once("exit", () => {
      this.failPending(this.protocolError ?? new Error("Codex app-server exited"));
      this.markExited();
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      if (child.pid !== undefined) { resolvePromise(); return; }
      const onSpawn = () => { child.removeListener("error", onError); resolvePromise(); };
      const onError = (error: Error) => { child.removeListener("spawn", onSpawn); rejectPromise(error); };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    const initialized = record(await this.request("initialize", {
      clientInfo: { name: "dash_codex", title: "Dash", version: "0.1.0" },
    }));
    this.userAgent = string(initialized?.userAgent) ?? "";
    this.notify("initialized", {});
  }

  waitForExit(): Promise<void> { return this.exitPromise; }
  get isExited(): boolean { return this.exited; }

  async request(method: string, params: Record<string, unknown>, timeoutMs = this.options.timeoutMs): Promise<unknown> {
    if (this.exited || this.closing || !this.child?.stdin?.writable) throw new Error("Codex app-server is not running");
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectPromise(new CodexRpcTimeoutError(method));
      }, timeoutMs);
      this.pending.set(String(id), { method, resolve: resolvePromise, reject: rejectPromise, timer });
      try { this.child!.stdin!.write(`${JSON.stringify({ method, id, params })}\n`); }
      catch {
        clearTimeout(timer); this.pending.delete(String(id));
        rejectPromise(new Error("Codex app-server request could not be written"));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.exited || this.closing || !this.child?.stdin?.writable) return;
    try { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); }
    catch { this.options.onError?.("write_failed"); }
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.failPending(new Error("Codex app-server closed"));
    try { this.child?.stdin?.end(); } catch {}
    try { this.child?.kill("SIGTERM"); } catch {}
    const child = this.child;
    if (child && !this.exited) {
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 500);
      timer.unref?.();
    }
    this.lines?.close();
  }

  private onLine(line: string): void {
    let message: Record<string, unknown> | null;
    try { message = record(JSON.parse(line)); } catch { message = null; }
    if (!message) { this.options.onError?.("invalid_json_line"); return; }
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id as RpcId : undefined;
    if (id !== undefined && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(String(id));
      if (!pending) return;
      this.pending.delete(String(id)); clearTimeout(pending.timer);
      const error = record(message.error);
      if (error) {
        const code = typeof error.code === "number" && Number.isInteger(error.code) ? error.code : undefined;
        const text = typeof error.message === "string" ? error.message : "Codex app-server rejected the request";
        pending.reject(new CodexRpcError(code, text, pending.method));
      } else pending.resolve(message.result);
      return;
    }
    const method = string(message.method);
    if (!method) return;
    const params = record(message.params) ?? {};
    if (id !== undefined) {
      this.options.onServerRequest(method, params);
      try {
        this.child?.stdin?.write(`${JSON.stringify({ id, error: {
          code: -32601,
          message: "unsupported by Dash: this app-server request is not implemented",
        } })}\n`);
      } catch { this.options.onError?.("request_rejected"); }
      return;
    }
    this.options.onNotification(method, params);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexRpcUnknownError(pending.method, "request_interrupted", error.message));
    }
    this.pending.clear();
  }

  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    this.exitResolve();
  }
}

function processErrorCode(error: unknown): string {
  const value = record(error);
  return typeof value?.code === "string" ? value.code.slice(0, 40) : "spawn_error";
}

function versionFromUserAgent(userAgent: string): string | undefined {
  const match = /(?:^|\/)(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/.exec(userAgent) ??
    /codex-cli\s+(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/i.exec(userAgent);
  return match?.[1];
}

function supports160(version: string | undefined): boolean {
  return !!version && /^0\.160\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version);
}

function textFromInputs(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap(item => {
    const input = record(item);
    return input?.type === "text" && typeof input.text === "string" ? [input.text] : [];
  }).join("");
}

function turnPrompt(turn: Record<string, unknown>): string | undefined {
  if (!Array.isArray(turn.items)) return undefined;
  const items = turn.items.flatMap(item => {
    const value = record(item);
    return value?.type === "userMessage" ? [textFromInputs(value.content)] : [];
  }).filter(Boolean);
  return items.length ? shortText(items.at(-1), textLimit) : undefined;
}

function turnOutput(turn: Record<string, unknown>): string | undefined {
  if (!Array.isArray(turn.items)) return undefined;
  const messages = turn.items.flatMap(item => {
    const value = record(item);
    return value?.type === "agentMessage" && typeof value.text === "string" ? [value] : [];
  });
  const final = messages.filter(message => message.phase === "final_answer");
  const visible = final.length ? final : messages.filter(message => message.phase === "commentary" || message.phase == null);
  const text = visible.map(message => string(message.text) ?? "").filter(Boolean).join("\n\n").trim();
  return text ? shortText(text, textLimit) : undefined;
}

function threadStatus(thread: Record<string, unknown>): "busy" | "idle" | "unknown" {
  const status = record(thread.status);
  if (status?.type === "active") return "busy";
  if (status?.type === "idle") return "idle";
  return "unknown";
}

function codexControlInfo(source: string, version: string | undefined, features: { turnStart: boolean; turnSteer: boolean; turnInterrupt: boolean }, activeTurnId?: string | null): CodexControlInfo {
  return {
    source,
    appServerOwned: source === "appServer",
    ...(version ? { version } : {}),
    turnStart: features.turnStart,
    turnSteer: features.turnSteer,
    turnInterrupt: features.turnInterrupt,
    activeTurnId: activeTurnId ?? null,
  };
}

function messageCode(error: unknown): "unsupported_method" | "stale_turn" | "codex_error" {
  if (error instanceof CodexRpcError && error.code === -32601) return "unsupported_method";
  if (error instanceof CodexRpcError && /turn.*(not active|does not match|stale)|expected.*turn/i.test(error.message)) return "stale_turn";
  return "codex_error";
}

export function createCodexAdapter(options: CodexAdapterOptions): CodexAdapter {
  if (!hostPattern.test(options.host)) throw new Error("Codex host must be a 1-64 character label");
  if (!options.identities.length) throw new Error("At least one Codex identity is required");
  const now = options.now ?? Date.now;
  const fetcher = options.fetchImpl ?? fetch;
  const command = options.command ?? process.env.DASH_CODEX_BIN ?? "codex";
  const args = options.args ?? ["app-server"];
  const spawnImpl = options.spawnImpl ?? spawn;
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 15_000);
  const retryDelayMs = Math.max(50, options.retryDelayMs ?? 2_000);
  const requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 15_000);
  const restartDelayMs = Math.max(50, options.restartDelayMs ?? 1_000);
  const hub = options.hubUrl ? new URL(options.hubUrl).origin : undefined;
  const shouldForward = Boolean(hub && options.forwardEvents);
  const profiles = options.identities.map(identity => ({
    identity,
    state: "starting" as "starting" | "ready" | "offline",
    app: undefined as CodexAppServer | undefined,
    version: undefined as string | undefined,
    features: { turnStart: false, turnSteer: false, turnInterrupt: false },
    resumeSupported: true,
    sessionByThread: new Map<string, string>(),
    threadBySession: new Map<string, string>(),
    metadataSignature: new Map<string, string>(),
    controlSignature: new Map<string, string>(),
    turnSignature: new Map<string, string>(),
    failedTurnReads: new Set<string>(),
    emittedTerminalSignatureByThread: new Map<string, Map<string, string>>(),
    activeTurnByThread: new Map<string, string>(),
    threadStatusById: new Map<string, "busy" | "idle" | "unknown">(),
    threadBySessionMetadata: new Map<string, { title?: string; cwd?: string; source: string }>(),
    metadataByThread: new Map<string, { source: string; title: string; cwd: string | undefined; updatedAt: number; signature: string }>(),
    turnIdsByThread: new Map<string, Set<string>>(),
    startingTurnByThread: new Map<string, TurnStartReservation>(),
    loaded: new Set<string>(),
    pollers: new Map<string, AbortController>(),
    syncing: false,
    syncAgain: false,
  }));
  const pendingForward = new Map<string, NormalizedEvent>();
  const identityErrors = new Set<string>();
  let closed = false;
  const { promise: closedSignal, resolve: signalClosed } = Promise.withResolvers<void>();
  let started = false;
  let forwarding = false;
  let lastLivenessKey = "";
  let lastLivenessAt = Number.NEGATIVE_INFINITY;
  let forwardInterval: ReturnType<typeof setInterval> | undefined;

  const report = (area: string, code: string) => {
    const key = `${area}:${code}`;
    if (identityErrors.has(key)) return;
    identityErrors.add(key);
    options.onError?.(area, code);
  };

  const post = async (path: string, body: unknown, timeoutMs = 5_000, eventId?: string): Promise<Response> => {
    if (!hub) throw new Error("Codex relay URL is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(`${hub}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dash-Host": options.host, ...(eventId ? { "X-Dash-Event-Id": eventId } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
  };

  const flushForward = async () => {
    if (!shouldForward || forwarding || closed) return;
    forwarding = true;
    try {
      while (pendingForward.size && !closed) {
        const [key, event] = pendingForward.entries().next().value as [string, NormalizedEvent];
        let response: Response;
        try { response = await post("/ingest/codex", event, 5_000, key); }
        catch { report("codex ingest", "transport_error"); break; }
        if (!response.ok) { report("codex ingest", `http_${response.status}`); break; }
        pendingForward.delete(key);
      }
    } finally { forwarding = false; }
  };

  const emitEvent = async (event: NormalizedEvent) => {
    await options.onEvent(event);
    if (!shouldForward) return;
    const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    if (!pendingForward.has(digest)) pendingForward.set(digest, event);
    if (pendingForward.size > 2_000) pendingForward.delete(pendingForward.keys().next().value!);
    void flushForward();
  };

  const livenessRecords = (): LivenessRecord[] => profiles.flatMap(profile => [...profile.loaded].flatMap(threadId => {
    const sessionId = profile.sessionByThread.get(threadId);
    if (!sessionId) return [];
    const meta = profile.threadBySessionMetadata.get(sessionId);
    return [{ host: options.host, harness: "codex" as const, sessionId,
      ...(meta?.cwd ? { cwd: meta.cwd } : {}), ...(meta?.title ? { name: meta.title } : {}),
      detail: profile.threadStatusById.get(threadId) ?? "unknown" }];
  }));

  const publishLiveness = async (force = false) => {
    const records = livenessRecords();
    const signature = JSON.stringify(records.map(({ sessionId, detail }) => [sessionId, detail]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    if (!force && signature === lastLivenessKey && now() - lastLivenessAt < 60_000) return;
    let delivered = true;
    try { await options.onLiveness(records); } catch { delivered = false; report("codex liveness", "local_update_failed"); }
    if (shouldForward) {
      try {
        const response = await post("/ingest/liveness/codex", { host: options.host, sessions: records.map(({ sessionId, cwd, name, detail }) => ({ sessionId, cwd, name, detail })) });
        if (!response.ok) { delivered = false; report("codex liveness", `http_${response.status}`); }
      } catch { delivered = false; report("codex liveness", "transport_error"); }
    }
    if (delivered) { lastLivenessKey = signature; lastLivenessAt = now(); }
  };

  const stopPoller = (profile: typeof profiles[number], sessionId: string) => {
    const controller = profile.pollers.get(sessionId);
    if (!controller) return;
    profile.pollers.delete(sessionId);
    controller.abort();
  };

  const stopPollers = (profile: typeof profiles[number]) => {
    for (const sessionId of [...profile.pollers.keys()]) stopPoller(profile, sessionId);
  };

  const ackControl = async (profile: typeof profiles[number], waiter: string, message: CodexControlMessage,
    outcome: "accepted" | "unsupported" | "failed" | "unknown", reason?: string) => {
    if (!hub) return;
    while (!closed) {
      try {
        const response = await post("/reply/ack", { id: message.id, waiter, target: message.target, outcome, ...(reason ? { reason } : {}) });
        if (response.ok) return;
        report("codex control receipt", `http_${response.status}`);
        if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) return;
      } catch { report("codex control receipt", "transport_error"); }
      await new Promise(resolvePromise => setTimeout(resolvePromise, retryDelayMs));
    }
  };

  const dispatchControl = async (profile: typeof profiles[number], threadId: string, message: CodexControlMessage): Promise<CodexControlDispatchResult> => {
    const app = profile.app;
    if (!app || profile.state !== "ready") return { outcome: "failed" };
    if (message.action !== "turn/start" && message.action !== "turn/steer" && message.action !== "turn/interrupt") return { outcome: "unsupported" };
    if (message.action === "turn/start" && (!profile.features.turnStart || !message.text?.trim())) return { outcome: "unsupported" };
    if (message.action === "turn/steer" && (!profile.features.turnSteer || !message.text?.trim())) return { outcome: "unsupported" };
    if (message.action === "turn/interrupt" && !profile.features.turnInterrupt) return { outcome: "unsupported" };
    if (message.action !== "turn/start" && (!message.expectedTurnId || profile.activeTurnByThread.get(threadId) !== message.expectedTurnId)) return { outcome: "failed" };
    const starting = message.action === "turn/start";
    if (starting && (profile.activeTurnByThread.has(threadId) || profile.startingTurnByThread.has(threadId)))
      return { outcome: "failed", reason: "turn_active" };
    if (starting) {
      const known = profile.turnIdsByThread.get(threadId);
      profile.startingTurnByThread.set(threadId, {
        baselineTurnIds: known ? new Set(known) : null,
        prompt: message.text!,
        requestedAt: now(),
      });
    }
    let keepStartReservation = false;
    try {
      if (starting && !profile.loaded.has(threadId) && profile.resumeSupported) {
        try { await app.request("thread/resume", { threadId, excludeTurns: true }); }
        catch (error) {
          if (!(error instanceof CodexRpcError && error.code === -32601 && error.method === "thread/resume")) throw error;
          profile.resumeSupported = false;
          profile.loaded.add(threadId);
        }
      }
      if (starting) {
        const reservation = profile.startingTurnByThread.get(threadId);
        if (reservation) reservation.requestedAt = now();
        await app.request("turn/start", { threadId, input: [{ type: "text", text: message.text! }], clientUserMessageId: `dash-${message.id}` });
        keepStartReservation = true;
      } else if (message.action === "turn/steer") {
        await app.request("turn/steer", { threadId, input: [{ type: "text", text: message.text! }], expectedTurnId: message.expectedTurnId!, clientUserMessageId: `dash-${message.id}` });
      } else {
        await app.request("turn/interrupt", { threadId, turnId: message.expectedTurnId! });
      }
      return { outcome: "accepted" };
    } catch (error) {
      if (error instanceof CodexRpcUnknownError && error.method === "turn/start") keepStartReservation = true;
      if (error instanceof CodexRpcUnknownError && error.method !== "thread/resume") {
        report("codex control", error.reason);
        return { outcome: "unknown", reason: error.reason };
      }
      if (error instanceof CodexRpcError && error.code === -32601) {
        if (error.method === message.action) {
          if (message.action === "turn/start") profile.features.turnStart = false;
          if (message.action === "turn/steer") profile.features.turnSteer = false;
          if (message.action === "turn/interrupt") profile.features.turnInterrupt = false;
          await emitEvent({ host: options.host, harness: "codex", sessionId: profile.sessionByThread.get(threadId)!,
            kind: "error", ts: now(), interactive: true, accountAlias: profile.identity.accountAlias, responseSource: "backfill",
            text: "The Codex app-server rejected this control method as unsupported.", detail: "unsupported_method",
            codexControl: codexControlInfo("appServer", profile.version, profile.features, profile.activeTurnByThread.get(threadId) ?? null) });
          return { outcome: "unsupported" };
        }
      }
      const reason = messageCode(error);
      report("codex control", reason);
      if (reason === "stale_turn") return { outcome: "failed", reason };
      return { outcome: "failed" };
    } finally {
      if (starting && !keepStartReservation) profile.startingTurnByThread.delete(threadId);
      if (profile.app === app && !app.isExited) syncInBackground(profile, app);
    }
  };

  const runPoller = async (profile: typeof profiles[number], sessionId: string, threadId: string,
    controller: AbortController) => {
    if (!hub) return;
    const waiter = randomBytes(16).toString("base64url");
    const startedAt = now();
    while (!closed && !controller.signal.aborted && profile.app && profile.state === "ready") {
      const url = new URL("/reply/wait/codex", hub);
      url.searchParams.set("session", sessionId);
      url.searchParams.set("waiter", waiter);
      url.searchParams.set("started", String(startedAt));
      url.searchParams.set("wait", "55");
      url.searchParams.set("commit", "1");
      let response: Response;
      try {
        response = await fetcher(url, { headers: { "X-Dash-Host": options.host }, signal: controller.signal });
      } catch {
        if (controller.signal.aborted) return;
        await new Promise(resolvePromise => setTimeout(resolvePromise, retryDelayMs));
        continue;
      }
      if (response.status === 204) continue;
      if (response.status === 410) return;
      if (response.status === 409) { await new Promise(resolvePromise => setTimeout(resolvePromise, 500)); continue; }
      if (response.status !== 200) {
        report("codex control", `poll_http_${response.status}`);
        await new Promise(resolvePromise => setTimeout(resolvePromise, retryDelayMs));
        continue;
      }
      let raw: unknown;
      try { raw = await response.json(); } catch { report("codex control", "invalid_delivery"); continue; }
      const item = record(raw);
      if (!item || !Number.isSafeInteger(item.id) || Number(item.id) < 1 || item.target !== sessionKey(options.host, sessionId) ||
          (item.action !== "turn/start" && item.action !== "turn/steer" && item.action !== "turn/interrupt") ||
          (item.action !== "turn/interrupt" && typeof item.text !== "string") ||
          (item.action !== "turn/start" && (typeof item.expectedTurnId !== "string" || !threadIdPattern.test(item.expectedTurnId)))) {
        report("codex control", "invalid_delivery");
        continue;
      }
      const message: CodexControlMessage = {
        id: Number(item.id), target: String(item.target), action: item.action as CodexAction,
        ...(typeof item.text === "string" ? { text: item.text } : {}),
        ...(typeof item.expectedTurnId === "string" ? { expectedTurnId: item.expectedTurnId } : {}),
      };
      let committed: Response;
      try { committed = await post("/reply/commit", { id: message.id, waiter, target: message.target }); }
      catch {
        report("codex control", "commit_transport_error");
        if (controller.signal.aborted) return;
        await new Promise(resolvePromise => setTimeout(resolvePromise, retryDelayMs));
        continue;
      }
      if (!committed.ok) { report("codex control", `commit_http_${committed.status}`); continue; }
      const dispatch = await dispatchControl(profile, threadId, message);
      const outcome = dispatch.outcome;
      const reason = dispatch.reason ?? (outcome === "unsupported" ? "unsupported_method" : outcome === "failed" ?
        message.action !== "turn/start" && profile.activeTurnByThread.get(threadId) !== message.expectedTurnId ? "stale_turn" : "codex_error" : undefined);
      await ackControl(profile, waiter, message, outcome, reason);
    }
  };

  const reconcilePollers = (profile: typeof profiles[number]) => {
    if (!hub || !options.repliesEnabled || profile.state !== "ready") {
      stopPollers(profile); return;
    }
    const desired = new Map<string, string>();
    for (const [threadId, sessionId] of profile.sessionByThread) {
      const metadata = profile.threadBySessionMetadata.get(sessionId);
      if (metadata?.source === "appServer") desired.set(sessionId, threadId);
    }
    for (const sessionId of [...profile.pollers.keys()]) if (!desired.has(sessionId)) stopPoller(profile, sessionId);
    for (const [sessionId, threadId] of desired) {
      if (profile.pollers.has(sessionId)) continue;
      const controller = new AbortController();
      profile.pollers.set(sessionId, controller);
      void runPoller(profile, sessionId, threadId, controller);
    }
  };

  const listThreads = async (app: CodexAppServer): Promise<Record<string, unknown>[]> => {
    const output: Record<string, unknown>[] = [];
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      for (let page = 0; page < maxThreadPages; page++) {
        const params: Record<string, unknown> = { limit: pageLimit, archived, sourceKinds: ["cli", "vscode", "appServer"] };
        if (cursor) params.cursor = cursor;
        const result = record(await app.request("thread/list", params));
        if (!result || !Array.isArray(result.data)) throw new Error("Codex thread/list returned an invalid page");
        for (const item of result.data) { const thread = record(item); if (thread) output.push(thread); }
        const next = string(result.nextCursor);
        if (!next) break;
        cursor = next;
      }
    }
    return output;
  };

  const listLoaded = async (app: CodexAppServer): Promise<Set<string>> => {
    const loaded = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxThreadPages; page++) {
      const result = record(await app.request("thread/loaded/list", { limit: pageLimit, ...(cursor ? { cursor } : {}) }));
      if (!result || !Array.isArray(result.data)) throw new Error("Codex thread/loaded/list returned an invalid page");
      for (const id of result.data) if (typeof id === "string" && threadIdPattern.test(id)) loaded.add(id);
      const next = string(result.nextCursor);
      if (!next) break;
      cursor = next;
    }
    return loaded;
  };

  const readTurns = async (app: CodexAppServer, threadId: string): Promise<Record<string, unknown>[]> => {
    const result = record(await app.request("thread/turns/list", {
      threadId, limit: 5, sortDirection: "desc", itemsView: "full",
    }));
    if (!result || !Array.isArray(result.data)) throw new Error("Codex thread/turns/list returned an invalid page");
    return result.data.flatMap(item => { const turn = record(item); return turn ? [turn] : []; }).reverse();
  };

  const metadataFor = (thread: Record<string, unknown>) => {
    const source = typeof thread.source === "string" ? thread.source : "unknown";
    const title = shortText(thread.name, 4096) || shortText(thread.preview, 4096) || "Codex session";
    const cwd = shortText(thread.cwd, 4096);
    const updatedAt = asSeconds(thread.updatedAt) ?? asSeconds(thread.createdAt) ?? now();
    const signature = JSON.stringify([thread.id, thread.source, thread.name, thread.preview, thread.cwd, thread.status,
      thread.updatedAt, thread.recencyAt, thread.archived]);
    return { source, title, cwd, updatedAt, signature };
  };

  const syncRaw = async (profile: typeof profiles[number], app: CodexAppServer) => {
    const summaries = await listThreads(app);
    const seen = new Set<string>();
    const version = profile.version;
    for (const summary of summaries) {
      const threadId = string(summary.id);
      if (!threadId || !threadIdPattern.test(threadId)) continue;
      const sessionId = sessionIdForThread(profile.identity, threadId);
      if (!sessionId || !sessionIdPattern.test(sessionId)) continue;
      seen.add(threadId);
      profile.sessionByThread.set(threadId, sessionId);
      profile.threadBySession.set(sessionId, threadId);
      const previousSignature = profile.metadataSignature.get(threadId);
      const previousMetadata = profile.metadataByThread.get(threadId);
      let thread = summary;
      const summaryMeta = metadataFor(summary);
      if (previousSignature !== summaryMeta.signature) {
        try {
          const read = record(await app.request("thread/read", { threadId, includeTurns: false }));
          const hydrated = record(read?.thread);
          if (hydrated) thread = { ...summary, ...hydrated };
        } catch (error) {
          report("codex thread read", error instanceof CodexRpcError ? `rpc_${error.code ?? "unknown"}` : "request_failed");
        }
      }
      const meta = previousSignature === summaryMeta.signature && previousMetadata ? previousMetadata : metadataFor(thread);
      let sessionStartChecked = false;
      const emitSessionStart = async () => {
        sessionStartChecked = true;
        const sourceControl = codexControlInfo(meta.source, version, profile.features, profile.activeTurnByThread.get(threadId) ?? null);
        const snapshot = JSON.stringify([meta.signature, sourceControl]);
        const metadataChanged = previousSignature !== summaryMeta.signature;
        if (metadataChanged || profile.controlSignature.get(threadId) !== snapshot) {
          profile.metadataSignature.set(threadId, summaryMeta.signature);
          profile.controlSignature.set(threadId, snapshot);
          await emitEvent({ host: options.host, harness: "codex", sessionId, kind: "session_start",
            ts: metadataChanged ? meta.updatedAt : now(),
            cwd: meta.cwd, title: meta.title, accountAlias: profile.identity.accountAlias, detail: "history", interactive: true,
            codexControl: sourceControl });
        }
      };
      if (previousSignature !== summaryMeta.signature || !profile.turnSignature.has(threadId) ||
          profile.activeTurnByThread.has(threadId) || profile.failedTurnReads.has(threadId) || profile.startingTurnByThread.has(threadId)) {
        let turns: Record<string, unknown>[] | undefined;
        try {
          turns = await readTurns(app, threadId);
          profile.failedTurnReads.delete(threadId);
        } catch (error) {
          profile.failedTurnReads.add(threadId);
          report("codex thread turns", error instanceof CodexRpcError ? `rpc_${error.code ?? "unknown"}` : "request_failed");
        }
        if (turns) {
          const turnFingerprint = JSON.stringify(turns.map(turn => [turn.id, turn.status, turn.completedAt, turn.items]));
          if (profile.turnSignature.get(threadId) !== turnFingerprint) {
            profile.turnSignature.set(threadId, turnFingerprint);
            const previousActiveTurnId = profile.activeTurnByThread.get(threadId);
            let activeTurnId: string | undefined;
            const turnIds = new Set<string>();
            for (const turn of turns) {
              const turnId = string(turn.id);
              if (!turnId || !threadIdPattern.test(turnId)) continue;
              turnIds.add(turnId);
              if (turn.status === "inProgress") activeTurnId = turnId;
            }
            const startReservation = profile.startingTurnByThread.get(threadId);
            let submittedTurnId: string | undefined;
            let observedStartedTurn = Boolean(activeTurnId);
            if (startReservation) {
              if (startReservation.baselineTurnIds) {
                for (const turnId of turnIds) if (!startReservation.baselineTurnIds.has(turnId)) {
                  observedStartedTurn = true;
                  submittedTurnId = turnId;
                  break;
                }
              } else {
                const startedAfter = startReservation.requestedAt - turnStartClockSkewMs;
                for (const turn of turns) {
                  const turnId = string(turn.id);
                  if (!turnId || !threadIdPattern.test(turnId)) continue;
                  if (turn.status !== "completed" && turn.status !== "interrupted" && turn.status !== "failed") continue;
                  if (turnPrompt(turn) !== startReservation.prompt) continue;
                  const turnStartedAt = asSeconds(turn.startedAt);
                  if (turnStartedAt !== undefined && turnStartedAt >= startedAfter) {
                    observedStartedTurn = true;
                    submittedTurnId = turnId;
                    break;
                  }
                }
              }
            }
            if (observedStartedTurn) profile.startingTurnByThread.delete(threadId);
            profile.turnIdsByThread.set(threadId, turnIds);
            if (activeTurnId) profile.activeTurnByThread.set(threadId, activeTurnId);
            else profile.activeTurnByThread.delete(threadId);
            await emitSessionStart();
            let emittedTerminal = profile.emittedTerminalSignatureByThread.get(threadId);
            if (!emittedTerminal) profile.emittedTerminalSignatureByThread.set(threadId, emittedTerminal = new Map());
            for (const turnId of emittedTerminal.keys()) if (!turnIds.has(turnId)) emittedTerminal.delete(turnId);
            for (const turn of turns) {
              const turnId = string(turn.id);
              if (!turnId || !threadIdPattern.test(turnId)) continue;
              const prompt = turnPrompt(turn);
              if (turn.status === "inProgress") {
                if (turnId === activeTurnId && previousActiveTurnId !== turnId) {
                  await emitEvent({ host: options.host, harness: "codex", sessionId, kind: "prompt",
                    ts: asSeconds(turn.startedAt) ?? meta.updatedAt, cwd: meta.cwd, title: meta.title,
                    accountAlias: profile.identity.accountAlias, text: prompt, interactive: true,
                    codexControl: codexControlInfo(meta.source, version, profile.features, turnId) });
                }
              } else if (turn.status === "completed") {
                const text = turnOutput(turn);
                if (!text) continue;
                const signature = createHash("sha256").update("completed\\0").update(String(turn.completedAt ?? "")).update("\\0")
                  .update(prompt ?? "").update("\\0").update(text).digest("hex");
                if (emittedTerminal.get(turnId) === signature) continue;
                await emitEvent({ host: options.host, harness: "codex", sessionId, kind: "response",
                  ts: asSeconds(turn.completedAt) ?? meta.updatedAt, cwd: meta.cwd, title: meta.title,
                  accountAlias: profile.identity.accountAlias, text, prompt, interactive: true,
                  ...(previousActiveTurnId === turnId || submittedTurnId === turnId ? {} : { responseSource: "backfill" as const }),
                  codexControl: codexControlInfo(meta.source, version, profile.features, activeTurnId ?? null) });
                emittedTerminal.set(turnId, signature);
              } else if (turn.status === "interrupted" || turn.status === "failed") {
                const error = record(turn.error);
                const text = shortText(error?.message, detailLimit) ?? `Codex turn ${turn.status}.`;
                const signature = createHash("sha256").update(turn.status).update("\\0").update(String(turn.completedAt ?? "")).update("\\0")
                  .update(prompt ?? "").update("\\0").update(text).digest("hex");
                if (emittedTerminal.get(turnId) === signature) continue;
                await emitEvent({ host: options.host, harness: "codex", sessionId, kind: "error",
                  ts: asSeconds(turn.completedAt) ?? meta.updatedAt, cwd: meta.cwd, title: meta.title,
                  accountAlias: profile.identity.accountAlias, text, detail: turn.status, interactive: true,
                  ...(previousActiveTurnId === turnId || submittedTurnId === turnId ? {} : { responseSource: "backfill" as const }),
                  codexControl: codexControlInfo(meta.source, version, profile.features, activeTurnId ?? null) });
                emittedTerminal.set(turnId, signature);
              }
            }
          }
        }
      }
      if (!sessionStartChecked) await emitSessionStart();
      if (previousSignature !== summaryMeta.signature || !profile.threadStatusById.has(threadId))
        profile.threadStatusById.set(threadId, threadStatus(thread));
      profile.threadBySessionMetadata.set(sessionId, { source: meta.source, title: meta.title, cwd: meta.cwd });
      profile.metadataByThread.set(threadId, meta);
    }
    for (const threadId of [...profile.sessionByThread.keys()]) {
      if (seen.has(threadId)) continue;
      const sessionId = profile.sessionByThread.get(threadId)!;
      profile.sessionByThread.delete(threadId);
      profile.threadBySession.delete(sessionId);
      profile.metadataSignature.delete(threadId);
      profile.failedTurnReads.delete(threadId);
      profile.controlSignature.delete(threadId);
      profile.turnSignature.delete(threadId);
      profile.metadataByThread.delete(threadId);
      profile.turnIdsByThread.delete(threadId);
      profile.startingTurnByThread.delete(threadId);
      profile.emittedTerminalSignatureByThread.delete(threadId);
      profile.threadStatusById.delete(threadId);
      profile.activeTurnByThread.delete(threadId);
      profile.threadBySessionMetadata.delete(sessionId);
      stopPoller(profile, sessionId);
    }
    profile.loaded = await listLoaded(app);
    reconcilePollers(profile);
  };

  async function syncProfile(profile: typeof profiles[number], app: CodexAppServer): Promise<void> {
    if (profile.syncing) { profile.syncAgain = true; return; }
    profile.syncing = true;
    try {
      do {
        profile.syncAgain = false;
        await syncRaw(profile, app);
        await publishLiveness();
      } while (profile.syncAgain && !closed && profile.app === app && !app.isExited);
    } catch (error) {
      if (!closed) throw error;
    } finally { profile.syncing = false; }
  }
  const syncInBackground = (profile: typeof profiles[number], app: CodexAppServer) => {
    void syncProfile(profile, app).catch(error => {
      if (!closed && profile.app === app && !app.isExited) {
        report("codex app-server sync", error instanceof CodexRpcError ? `rpc_${error.code ?? "unknown"}` : processErrorCode(error));
      }
    });
  };
  async function syncSafely(profile: typeof profiles[number], app: CodexAppServer): Promise<void> {
    try { await syncProfile(profile, app); }
    catch (error) {
      if (closed || profile.app !== app || app.isExited) throw error;
      report("codex app-server sync", error instanceof CodexRpcError ? `rpc_${error.code ?? "unknown"}` : processErrorCode(error));
    }
  }


  const onServerRequest = (profile: typeof profiles[number], method: string, params: Record<string, unknown>) => {
    const threadId = string(params.threadId);
    if (!threadId || !threadIdPattern.test(threadId)) return;
    const sessionId = profile.sessionByThread.get(threadId) ?? sessionIdForThread(profile.identity, threadId);
    if (!sessionId) return;
    const source = profile.threadBySessionMetadata.get(sessionId)?.source ?? "unknown";
    const userInput = method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request";
    const text = userInput
      ? "Codex requested user input. Dash does not implement this operation; no answer was submitted."
      : method.includes("Approval") || method.includes("approval")
        ? "Codex requested approval. Dash does not implement approvals; no approval was granted."
        : "Codex requested an unsupported client operation; Dash did not provide a response payload.";
    void emitEvent({ host: options.host, harness: "codex", sessionId, kind: "permission", ts: now(),
      accountAlias: profile.identity.accountAlias, title: profile.threadBySessionMetadata.get(sessionId)?.title,
      cwd: profile.threadBySessionMetadata.get(sessionId)?.cwd, text, detail: method.slice(0, detailLimit),
      interactive: true, codexControl: codexControlInfo(source, profile.version, profile.features,
        profile.activeTurnByThread.get(threadId) ?? null) })
      .catch(() => report("codex app-server request", "event_delivery_failed"));
  };

  async function runProfile(profile: typeof profiles[number]): Promise<void> {
    let delay = restartDelayMs;
    while (!closed) {
      const app = new CodexAppServer({ command, args, identity: profile.identity, spawnImpl, timeoutMs: requestTimeoutMs,
        onNotification: method => {
          if (method === "turn/started" || method === "turn/completed" || method === "thread/started" || method === "thread/updated") {
            profile.syncAgain = true;
            syncInBackground(profile, app);
          }
        },
        onServerRequest: (method, params) => onServerRequest(profile, method, params),
        onError: code => report("codex app-server", code),
      });
      profile.app = app;
      profile.state = "starting";
      profile.resumeSupported = true;
      profile.metadataSignature.clear();
      profile.controlSignature.clear();
      profile.turnSignature.clear();
      profile.activeTurnByThread.clear();
      profile.threadStatusById.clear();
      try {
        await app.start();
        profile.version = versionFromUserAgent(app.userAgent);
        const verified160 = supports160(profile.version);
        profile.features = { turnStart: verified160, turnSteer: verified160, turnInterrupt: verified160 };
        profile.state = "ready";
        delay = restartDelayMs;
        await syncSafely(profile, app);
        const exited = app.waitForExit().then(() => "exit" as const);
        while (!closed && profile.app === app && !app.isExited) {
          const { promise: tick, resolve: resolveTick } = Promise.withResolvers<"tick">();
          const timer = setTimeout(() => resolveTick("tick"), pollIntervalMs);
          const result = await Promise.race([tick, exited]);
          clearTimeout(timer);
          if (result === "exit" || app.isExited) break;
          await syncSafely(profile, app);
        }
        if (!closed) throw new Error("Codex app-server exited");
      } catch (error) {
        profile.state = "offline";
        stopPollers(profile);
        profile.loaded.clear();
        profile.app = undefined;
        await publishLiveness(true);
        const code = error instanceof CodexRpcError ? `rpc_${error.code ?? "unknown"}` : processErrorCode(error);
        report("codex app-server", code);
      } finally {
        app.close();
        if (profile.app === app) profile.app = undefined;
      }
      if (closed) break;
      const { promise: delayElapsed, resolve: resolveDelay } = Promise.withResolvers<void>();
      const timer = setTimeout(resolveDelay, delay);
      const shouldRetry = await Promise.race([delayElapsed.then(() => true), closedSignal.then(() => false)]);
      clearTimeout(timer);
      if (!shouldRetry || closed) break;
      delay = Math.min(delay * 2, 30_000);
    }
  }


  return {
    start() {
      if (started) return this;
      started = true;
      for (const profile of profiles) void runProfile(profile);
      forwardInterval = setInterval(() => { if (pendingForward.size) void flushForward(); }, 5_000);
      forwardInterval.unref?.();
      return this;
    },
    async waitForReady(timeoutMs = 15_000) {
      const expiresAt = Date.now() + timeoutMs;
      while (!closed && Date.now() < expiresAt) {
        if (profiles.some(profile => profile.state === "ready")) return;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 20);
        await promise;
      }
      throw new Error("Codex app-server identities did not become ready before the deadline");
    },
    health() {
      return { enabled: started && !closed, identities: profiles.map(profile => ({
        accountAlias: profile.identity.accountAlias ?? null, state: profile.state, loaded: profile.loaded.size,
        version: profile.version ?? null,
      })) };
    },
    close() {
      if (closed) return;
      closed = true;
      signalClosed();
      clearInterval(forwardInterval);
      for (const profile of profiles) {
        stopPollers(profile);
        profile.app?.close();
        profile.loaded.clear();
        profile.state = "offline";
      }
      void publishLiveness(true);
    },
  };
}

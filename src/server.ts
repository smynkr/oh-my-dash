import { dirname, join, resolve } from "node:path";
import { isIP } from "node:net";
import { DashDB, type SessionDTO } from "./db.ts";
import { createTelegram, type TelegramOptions } from "./telegram.ts";
import { createReplies } from "./replies.ts";
import { createJudge } from "./judge.ts";
import { createExtraction } from "./extraction.ts";
import { normalizeClaude, normalizeOmp, localHost, type EventKind } from "./normalize.ts";
import { scanBackfill, parseClaudeTranscript, findClaudeTranscript } from "./backfill.ts";
import { parseClaudeAgents, pollClaudeAgents, pollOmpPresence, type LivenessRecord } from "./liveness.ts";
import { resolveProject, ruleErrors, type ProjectRule } from "./projects.ts";

export const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
// DASH_ROOT lets a `bun build --compile` binary (where import.meta.dir is virtual) find public/ and node_modules/.
const root = process.env.DASH_ROOT ? resolve(process.env.DASH_ROOT) : resolve(import.meta.dir, "..");
const staticFiles: Record<string, [string, string]> = {
  "/": [join(root, "public/index.html"), "text/html; charset=utf-8"],
  "/index.html": [join(root, "public/index.html"), "text/html; charset=utf-8"],
  "/app.js": [join(root, "public/app.js"), "text/javascript; charset=utf-8"],
  "/app.css": [join(root, "public/app.css"), "text/css; charset=utf-8"],
  "/vendor/marked.js": [join(root, "node_modules/marked/lib/marked.umd.js"), "text/javascript; charset=utf-8"],
  "/vendor/purify.js": [join(root, "node_modules/dompurify/dist/purify.min.js"), "text/javascript; charset=utf-8"],
};
const headers = (extra: HeadersInit = {}) => ({ "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", ...extra });
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: headers({ "Content-Type": "application/json" }) });
const ack = () => new Response("{}", { status: 200, headers: headers({ "Content-Type": "application/json" }) });
const jsonContentType = (value: string | null) => /^application\/json(?:\s*;\s*charset\s*=\s*[^;\s]+)?$/i.test(value ?? "");
const hostLabel = (value: string | null): value is string => !!value && /^[A-Za-z0-9_-]{1,64}$/.test(value);

function allowedPeers(raw: string): Map<string, string> {
  const peers = new Map<string, string>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const separator = entry.indexOf("=");
    const label = separator < 0 ? "*" : entry.slice(0, separator).trim();
    const ip = separator < 0 ? entry : entry.slice(separator + 1).trim();
    if ((label !== "*" && !hostLabel(label)) || !isIP(ip) || peers.has(ip)) throw new Error("invalid DASH_ALLOWED_PEERS entry");
    peers.set(ip, label);
  }
  return peers;
}

async function boundedJson(request: Request): Promise<unknown> {
  const max = 2 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > max) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) { void reader.cancel(); return null; }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(body));
  } catch { return null; }
}

export interface ServerOptions {
  port?: number; hostname?: string; tailnetPort?: number; dataPath?: string; backfill?: boolean; liveness?: boolean;
  pollClaude?: () => Promise<LivenessRecord[]>;
  pollOmp?: () => Promise<LivenessRecord[] | null>;
  now?: () => number;
  telegram?: Partial<Omit<TelegramOptions, "db">>;
  judge?: { bin?: string; dataDir?: string; timeoutMs?: number };
}

function projectRulesShapeError(value: unknown): number | undefined {
  if (!Array.isArray(value)) return -1;
  if (value.length > 32) return 32;
  for (let index = 0; index < value.length; index++) {
    const rule = value[index];
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return index;
    if (Object.keys(rule).some(key => key !== "pattern" && key !== "project") ||
      typeof rule.pattern !== "string" || rule.pattern.length < 1 || rule.pattern.length > 256 ||
      typeof rule.project !== "string" || rule.project.length < 1 || rule.project.length > 128) return index;
  }
}

export function createDashServer(options: ServerOptions = {}) {
  const topicsEnabled = process.env.DASH_TG_TOPICS === "1";
  const decisionsEnabled = process.env.DASH_REPLIES === "1";
  const judgeEnabled = decisionsEnabled && process.env.DASH_JUDGE === "1";
  const dataDir = options.dataPath && options.dataPath !== ":memory:" ? dirname(resolve(options.dataPath)) : resolve(process.env.DASH_DATA ?? join(root,"data"));
  const db = new DashDB(options.dataPath ?? join(dataDir, "dash.sqlite"), { topicsEnabled, decisionsEnabled, judgeEnabled });
  const now = options.now ?? Date.now;
  const started = now();
  let malformed = 0;
  let rejected = 0;
  const lastRemoteLiveness = new Map<string, number>();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const lastDto = new Map<string, string>();
  let telegram: ReturnType<typeof createTelegram> | undefined;
  let replies: ReturnType<typeof createReplies> | undefined;
  const send = (dto: SessionDTO, eventKind?: EventKind, force = false) => {
    // An error event can have the same DTO as an earlier liveness/update event.
    // Let Telegram see the actual event before DTO dedupe, without inferring
    // errors from a DTO's potentially stale lastError field.
    if (eventKind === "error") telegram?.observe(dto, eventKind);
    const serialized = JSON.stringify(dto);
    if (!force && lastDto.get(dto.key) === serialized) return;
    lastDto.set(dto.key, serialized);
    const message = encoder.encode(`event: session\ndata: ${serialized}\n\n`);
    for (const client of [...clients]) try { client.enqueue(message); } catch { clients.delete(client); }
    if (eventKind !== "error") telegram?.observe(dto, eventKind);
    replies?.observe(dto);
  };
  const heartbeat = setInterval(() => {
    for (const client of [...clients]) try { client.enqueue(encoder.encode(": heartbeat\n\n")); } catch { clients.delete(client); }
  }, 8_000);
  const errors = new Set<string>();
  const reportError = (area: string, error: unknown) => {
    const code = error instanceof Error ? `${error.name}:${(error as NodeJS.ErrnoException).code ?? "unknown"}` : typeof error;
    const key = `${area}:${code}`;
    if (!errors.has(key)) { errors.add(key); console.error(`dash ${area}: ${code}`); }
  };
  const ttl = Number(process.env.DASH_REPLY_TTL_MIN);
  const ttlMin = Number.isInteger(ttl) && ttl >= 1 && ttl <= 1440 ? ttl : 15;
  const emitReply = (reply: { id: number; sessionKey: string; source: string }, state: string) => {
    const message = encoder.encode(`event: reply\ndata: ${JSON.stringify({ key: reply.sessionKey, replyId: reply.id, state, source: reply.source })}\n\n`);
    for (const client of [...clients]) try { client.enqueue(message); } catch { clients.delete(client); }
  };
  if (process.env.DASH_REPLIES === "1") replies = createReplies({ db, now, ttlMs: ttlMin * 60_000, send,
    onQueued: reply => emitReply(reply, "queued"),
    onOutcome: (reply, outcome, dto) => { telegram?.replyOutcome(reply, outcome, dto, ttlMin); emitReply(reply, outcome); } });
  if (process.env.DASH_TELEGRAM === "1") telegram = createTelegram({ ...options.telegram, topicsEnabled, db, now: options.telegram?.now ?? now, reportError, replies });
  // The Luna tier exists only with both flags on; otherwise no codex process can ever be spawned.
  const extraction = judgeEnabled ? createExtraction({ db, reportError,
    judge: createJudge({ bin: options.judge?.bin || process.env.DASH_CODEX_BIN || "codex", dataDir: options.judge?.dataDir ?? dataDir }),
    timeoutMs: options.judge?.timeoutMs,
    onCurrent: (dto, id) => { send(dto, undefined, true); telegram?.observeDecisions(dto, id); } }) : undefined;
  async function runBackfill() {
    let sessions = 0, responses = 0;
    try {
      for (const item of await scanBackfill()) {
        const before = db.countResponses();
        send(db.addBackfill(item));
        sessions++;
        // Count inserted rows without reporting text or paths.
        responses += db.countResponses() - before;
      }
    } catch (error) { reportError("backfill", error); }
    return { sessions, responses };
  }
  async function runLiveness() {
    try {
      const rows = await (options.pollClaude ?? pollClaudeAgents)();
      for (const dto of db.markLiveness("claude", rows, localHost())) {
        send(dto);
        if (dto.host !== localHost()) continue;
        if (!db.hasResponses(dto.host, dto.harness, dto.sessionId) && !backfillAttempted.has(dto.key)) {
          backfillAttempted.add(dto.key);
          const transcript = dto.transcriptPath ? parseClaudeTranscript(dto.transcriptPath) : await findClaudeTranscript(dto.sessionId);
          if (transcript) send(db.addBackfill(transcript));
        }
      }
    } catch (error) { reportError("claude liveness", error); }
    for (const dto of db.sweepDeadClaude(localHost())) send(dto);
    try {
      const omp = await (options.pollOmp ?? pollOmpPresence)();
      if (omp) for (const dto of db.markLiveness("omp", omp, localHost())) send(dto);
    } catch (error) { reportError("omp liveness", error); }
  }
  const backfillAttempted = new Set<string>();
  const configuredTailnetPort = process.env.DASH_TAILNET_PORT?.trim();
  const rawTailnetPort = options.tailnetPort ?? (configuredTailnetPort === undefined || configuredTailnetPort === "" ? undefined : configuredTailnetPort);
  const validPort = rawTailnetPort === undefined || (typeof rawTailnetPort === "number" ?
    Number.isInteger(rawTailnetPort) && rawTailnetPort >= 0 && rawTailnetPort <= 65535 :
    /^\d+$/.test(rawTailnetPort) && Number.isInteger(Number(rawTailnetPort)) && Number(rawTailnetPort) >= 1 && Number(rawTailnetPort) <= 65535);
  if (!validPort) { replies?.close(); clearInterval(heartbeat); db.close(); throw new Error("DASH_TAILNET_PORT must be an integer port 1-65535"); }
  const tailnetPort = rawTailnetPort === undefined ? undefined : Number(rawTailnetPort);
  let peers: Map<string, string>;
  try { peers = allowedPeers(process.env.DASH_ALLOWED_PEERS ?? ""); }
  catch (error) { replies?.close(); clearInterval(heartbeat); db.close(); throw error; }
  const handle = async (request: Request, port: number, disableTimeout: () => void, listener: "loopback" | "tailnet") => {
    const url = new URL(request.url);
    const path = url.pathname;
    const ingestPath = path.startsWith("/ingest/");
    const ingest = request.method === "POST" && (path === "/ingest/claude" || path === "/ingest/omp" || path === "/ingest/liveness/claude");
    const loopbackHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    const extraHosts = new Set((process.env.DASH_ALLOWED_HOSTS ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean));
    const host = request.headers.get("host")?.toLowerCase() ?? "";
    const peer = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
    const allowed = listener === "loopback"
      ? loopbackHosts.has(host) && !["x-forwarded-for", "tailscale-user-login", "x-forwarded-host"].some(h => request.headers.has(h))
      : !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) && extraHosts.has(host) && peers.has(peer);
    if (!allowed) {
      if (ingestPath) { rejected++; return ack(); }
      return json({ error: "forbidden" }, 403);
    }
    const projectRulesRoute = path === "/api/projects/rules";
    const projectPreviewRoute = path === "/api/projects/preview";
    if (request.method === "POST" && path.startsWith("/api/")) {
      const origin = request.headers.get("origin");
      const originAllowed = origin !== null && (listener === "loopback"
        ? [...loopbackHosts].some(h => origin === `http://${h}`)
        : [...extraHosts].some(h => origin === `https://${h}`));
      if (!originAllowed) return json({ error: "forbidden" }, 403);
      if (!jsonContentType(request.headers.get("content-type"))) return json({ error: "unsupported media type" }, 415);
    }
    if ((projectRulesRoute || projectPreviewRoute) && !topicsEnabled) return json({ error: "not found" }, 404);
    if (path === "/question/register" || path === "/question/wait" || path === "/question/cancel") {
      if (!replies) return json({ error:"not found" },404);
      const entrypoint = request.headers.get("X-Dash-Entrypoint");
      if (entrypoint !== "cli") return json({ error:"forbidden" },403);
      const label = request.headers.get("X-Dash-Host");
      if (listener === "loopback" ? label !== null && label !== localHost() :
        (!hostLabel(label) || label === localHost() || (peers.get(peer) !== "*" && label !== peers.get(peer))))
        return json({ error:"forbidden" },403);
      const host = listener === "loopback" ? localHost() : label!;
      const sessionKeyFor = (session: string) => `${host}|claude|${session}`;
      if (path === "/question/register" && request.method === "POST") {
        if (!jsonContentType(request.headers.get("content-type"))) return json({ error:"unsupported media type" },415);
        const body = await boundedJson(request) as Record<string, unknown> | null;
        if (!body || Object.keys(body).some(field =>
          !["sessionId","toolUseId","invocationId","questions","timeoutMs"].includes(field)) ||
          typeof body.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.sessionId) ||
          typeof body.toolUseId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(body.toolUseId) ||
          typeof body.invocationId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.invocationId) ||
          !Array.isArray(body.questions) || !Number.isSafeInteger(body.timeoutMs))
          return json({ error:"bad request" },400);
        const event = normalizeClaude({
          session_id:body.sessionId,hook_event_name:"PreToolUse",tool_name:"AskUserQuestion",
          tool_use_id:body.toolUseId,tool_input:{ questions:body.questions },
        },request.headers,now());
        if (!event) return json({ error:"invalid question" },400);
        const result = replies.registerQuestion({ event,id:body.invocationId,toolUseId:body.toolUseId,
          timeoutMs:Number(body.timeoutMs) });
        if ("ok" in result) return json({ questionId:result.questionId,expiresAt:result.expiresAt },201);
        const status = result.reason === "disabled" ? 404 :
          result.reason === "invalid_question" ? 400 : 409;
        return json(result,status);
      }
      if (path === "/question/wait" && request.method === "GET") {
        const names = ["session","toolUseId","question","wait"];
        if (names.some(name => url.searchParams.getAll(name).length !== 1) ||
            [...url.searchParams.keys()].some(name => !names.includes(name)))
          return json({ error:"bad request" },400);
        const session = url.searchParams.get("session")!, toolUseId = url.searchParams.get("toolUseId")!;
        const question = url.searchParams.get("question")!, rawWait = url.searchParams.get("wait")!;
        const waitSec = Number(rawWait);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(session) || !/^[A-Za-z0-9_-]{1,256}$/.test(toolUseId) ||
            !/^[A-Za-z0-9_-]{43}$/.test(question) || !/^\d+$/.test(rawWait) ||
            !Number.isInteger(waitSec) || waitSec < 1 || waitSec > 55)
          return json({ error:"bad request" },400);
        disableTimeout();
        const result = await replies.waitQuestion(sessionKeyFor(session),question,toolUseId,waitSec*1000,request.signal);
        return result.status === 200
          ? json({ answers:result.answers })
          : new Response(null,{ status:result.status,headers:headers({ "Cache-Control":"no-store" }) });
      }
      if (path === "/question/cancel" && request.method === "DELETE") {
        const names = ["session","toolUseId","question"];
        if (names.some(name => url.searchParams.getAll(name).length !== 1) ||
            [...url.searchParams.keys()].some(name => !names.includes(name)))
          return json({ error:"bad request" },400);
        const session = url.searchParams.get("session")!, toolUseId = url.searchParams.get("toolUseId")!;
        const question = url.searchParams.get("question")!;
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(session) || !/^[A-Za-z0-9_-]{1,256}$/.test(toolUseId) ||
            !/^[A-Za-z0-9_-]{43}$/.test(question))
          return json({ error:"bad request" },400);
        return replies.cancelQuestion(question,sessionKeyFor(session),toolUseId)
          ? json({ ok:true }) : json({ error:"stale question" },409);
      }
      return json({ error:"not found" },404);
    }
    if (path === "/reply/wait/claude" || path === "/reply/wait/omp" || path === "/reply/ack" || path === "/reply/commit") {
      if (!replies) return json({ error: "not found" }, 404);
      if (request.method === "GET" && path.startsWith("/reply/wait/")) {
        if (["session", "waiter", "started", "wait", "commit"].some(name => url.searchParams.getAll(name).length > 1)) return json({ error: "bad request" }, 400);
        const session = url.searchParams.get("session"), waiter = url.searchParams.get("waiter");
        const rawStarted = url.searchParams.get("started"), rawWait = url.searchParams.get("wait");
        const rawCommit = url.searchParams.get("commit");
        const waitSec = rawWait === null ? 50 : Number(rawWait);
        if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session) || !waiter || !/^[A-Za-z0-9_-]{8,64}$/.test(waiter) ||
          !rawStarted || !/^-?\d+$/.test(rawStarted) || !Number.isSafeInteger(Number(rawStarted)) ||
          (rawWait !== null && !/^\d+$/.test(rawWait)) || !Number.isInteger(waitSec) || waitSec < 1 || waitSec > 55 ||
          (rawCommit !== null && (path.endsWith("claude") || rawCommit !== "1"))) return json({ error: "bad request" }, 400);
        const label = request.headers.get("X-Dash-Host");
        if (listener === "loopback" ? (label !== null && label !== localHost()) :
          (!hostLabel(label) || label === localHost() || (peers.get(peer) !== "*" && label !== peers.get(peer)))) return json({ error: "forbidden" }, 403);
        const key = `${listener === "loopback" ? localHost() : label}|${path.endsWith("claude") ? "claude" : "omp"}|${session}`;
        disableTimeout();
        const result = path.endsWith("claude")
          ? await replies.waitClaude(key, waiter, Number(rawStarted), waitSec * 1000, request.signal)
          : await replies.waitOmp(key, waiter, Number(rawStarted), waitSec * 1000, request.signal, rawCommit === "1", listener === "loopback" ? "loopback" : peer);
        if (result.status !== 200) return new Response(null, { status: result.status, headers: headers() });
        return path.endsWith("claude")
          ? new Response(result.reply as string, { headers: headers({ "Content-Type": "text/plain; charset=utf-8" }) })
          : json(result.reply);
      }
      if (request.method === "POST" && (path === "/reply/ack" || path === "/reply/commit")) {
        if (!jsonContentType(request.headers.get("content-type"))) return json({ error: "bad request" }, 400);
        const body = await boundedJson(request) as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || !Number.isSafeInteger(body.id) || Number(body.id) < 1 ||
          typeof body.waiter !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.waiter) ||
          (path === "/reply/ack" && body.outcome !== "sent" && body.outcome !== "deferred")) return json({ error: "bad request" }, 400);
        const reply = db.getReply(Number(body.id));
        const label = request.headers.get("X-Dash-Host");
        if (listener === "loopback" ? (label !== null && label !== localHost()) :
          (!hostLabel(label) || label === localHost() || (peers.get(peer) !== "*" && label !== peers.get(peer)) || (reply && !reply.sessionKey.startsWith(`${label}|`)))) return json({ error: "forbidden" }, 403);
        const leasePeer = listener === "loopback" ? "loopback" : peer;
        if (path === "/reply/commit") return replies.commitOmp(Number(body.id), body.waiter, leasePeer)
          ? json({ ok: true }) : json({ error: "not deliverable" }, 409);
        return replies.ackOmp(Number(body.id), body.waiter, body.outcome as "sent" | "deferred", leasePeer)
          ? json({ ok: true }) : json({ error: "not found" }, 404);
      }
      return json({ error: "not found" }, 404);
    }
    if (ingest) {
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*[^;\s]+)?$/i.test(request.headers.get("content-type") ?? "")) {
        rejected++; return ack();
      }
      try {
        const body = await boundedJson(request);
        const boundLabel = listener === "tailnet" ? peers.get(peer) : "*";
        if (boundLabel && boundLabel !== "*" && (path === "/ingest/omp"
          ? (body as Record<string, unknown> | null)?.host !== boundLabel
          : request.headers.get("X-Dash-Host") !== boundLabel)) { rejected++; return ack(); }
        if (path === "/ingest/liveness/claude") {
          const remoteHost = (request.headers.get("x-dash-host") ?? "").split(".")[0];
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(remoteHost)) { malformed++; return ack(); }
          if (remoteHost === localHost()) { rejected++; return ack(); }
          const records = parseClaudeAgents(body, remoteHost);
          const acceptedAt = now();
          for (const dto of db.markLiveness("claude", records, remoteHost, acceptedAt, () => false, true)) send(dto);
          lastRemoteLiveness.set(remoteHost, acceptedAt);
          return ack();
        }
        const event = path.endsWith("claude") ? normalizeClaude(body, request.headers, now()) : normalizeOmp(body, now());
        if (event) {
          const dto = db.applyEvent(event);
          send(dto, event.kind);
          if (event.kind === "response") extraction?.schedule(dto.key, dto.turnSeq);
        } else malformed++;
      } catch (error) { malformed++; reportError("ingest", error); }
      return ack();
    }
    if (request.method === "GET" && path === "/healthz") return json({ ok: true, sessions: db.countSessions(), rejected,
      uptimeSec: Math.floor((now()-started)/1000), tailnetPort: tailnetServer?.port ?? null,
      remoteHosts: Object.fromEntries([...lastRemoteLiveness].map(([h, ts]) => [h, Math.floor((now()-ts)/1000)])),
      telegram: telegram?.health() ?? { state: "disabled", mode: "input", paired: false, queued: 0, sent: 0, dropped: 0 },
      replies: replies?.health() ?? { enabled: false } });
    if (request.method === "GET" && path === "/api/telegram") return json(telegram?.info(listener === "loopback") ??
      { state: "disabled", mode: "input", paired: false, botUsername: null, pairingCode: null });
    if (request.method === "GET" && projectRulesRoute) {
      const { rules, errors } = db.getProjectRules();
      return json({ rules, errors });
    }
    if (request.method === "POST" && projectRulesRoute) {
      const body = await boundedJson(request) as { rules?: unknown } | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid rules", index: -1 }, 400);
      const invalidIndex = projectRulesShapeError(body.rules);
      if (invalidIndex !== undefined) return json({ error: "invalid rules", index: invalidIndex }, 400);
      const rules = body.rules as ProjectRule[];
      const invalidRegex = ruleErrors(rules)[0];
      if (invalidRegex) return json({ error: "invalid rules", index: invalidRegex.index }, 400);
      db.setSetting("projects.rules", JSON.stringify(rules));
      for (const dto of db.listSessions(true, true)) send(dto, undefined, true);
      return json({ rules, errors: [] });
    }
    if (request.method === "POST" && projectPreviewRoute) {
      const body = await boundedJson(request) as { cwd?: unknown; rules?: unknown } | null;
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.cwd !== "string" || body.cwd.length > 4096) {
        return json({ error: "bad request" }, 400);
      }
      let rules: ProjectRule[];
      let errors: { index: number; error: string }[];
      if (Object.prototype.hasOwnProperty.call(body, "rules")) {
        const invalidIndex = projectRulesShapeError(body.rules);
        if (invalidIndex !== undefined) return json({ error: "invalid rules", index: invalidIndex }, 400);
        rules = body.rules as ProjectRule[];
        errors = ruleErrors(rules);
      } else {
        const stored = db.getProjectRules();
        rules = stored.rules;
        errors = stored.errors;
      }
      return json({ project: resolveProject(body.cwd, rules), errors });
    }
    if (request.method === "POST" && path === "/api/telegram/unpair") {
      if (listener !== "loopback") return json({ error: "forbidden" }, 403);
      telegram?.unpair();
      return json({ ok: true });
    }
    const questionRoute = request.method === "POST" && path.match(/^\/api\/sessions\/([^/]+)\/question$/);
    if (questionRoute) {
      if (!replies) return json({ error:"not found" },404);
      let key: string;
      try { key = decodeURIComponent(questionRoute[1]); } catch { return json({ error:"invalid key" },400); }
      const body = await boundedJson(request) as Record<string, unknown> | null;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some(field => field !== "questionId" && field !== "answers") ||
          typeof body.questionId !== "string" || !Object.hasOwn(body,"answers"))
        return json({ error:"bad request" },400);
      const actor = listener === "loopback" ? "web:loopback" :
        `web:${peers.get(peer) === "*" ? `tailnet-peer-${peer.replace(/[^A-Za-z0-9_-]/g,"-")}` : peers.get(peer)}`;
      const result = replies.submitQuestion({ key,questionId:body.questionId,answers:body.answers,
        source:"web",actor,listener });
      if ("ok" in result) return json(result);
      const status = result.reason === "session_not_found" || result.reason === "disabled" ? 404 :
        result.reason.startsWith("invalid_") ? 400 : 409;
      return json(result,status);
    }
    const replyRoute = path.match(/^\/api\/sessions\/([^/]+)\/(reply|replies|replies\/cancel)$/);
    if (replyRoute && ((request.method === "POST" && replyRoute[2] !== "replies") ||
      (request.method === "GET" && replyRoute[2] === "replies"))) {
      if (!replies) return json({ error: "not found" }, 404);
      let key: string;
      try { key = decodeURIComponent(replyRoute[1]); } catch { return json({ error: "invalid key" }, 400); }
      if (replyRoute[2] === "reply") {
        const body = await boundedJson(request) as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some(field => field !== "text" && field !== "answersTurn" && field !== "answersQuestion")) return json({ error: "bad request" }, 400);
        const actor = listener === "loopback" ? "web:loopback" :
          `web:${peers.get(peer) === "*" ? `tailnet-peer-${peer.replace(/[^A-Za-z0-9_-]/g, "-")}` : peers.get(peer)}`;
        const result = replies.submit({ key, text: body.text as string, source: "web", actor,
          answersTurn: body.answersTurn as number | undefined, answersQuestion: body.answersQuestion as string | undefined, listener });
        if ("ok" in result) return json(result);
        const status = result.reason === "session_not_found" || result.reason === "disabled" ? 404 :
          result.reason.startsWith("invalid_") || result.reason === "empty_text" ? 400 : 409;
        return json(result, status);
      }
      if (!db.getSession(key)) return json({ error: "not found" }, 404);
      if (replyRoute[2] === "replies") return json({ replies: db.getReplies(key) });
      const body = await boundedJson(request) as Record<string, unknown> | null;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(field => field !== "id") ||
        (body.id !== undefined && (!Number.isSafeInteger(body.id) || Number(body.id) < 1))) return json({ error: "bad request" }, 400);
      return json({ ok: true, cancelled: replies.cancel(key, body.id as number | undefined).length });
    }
    if (request.method === "GET" && path === "/api/sessions") return json({ sessions: db.listSessions(url.searchParams.get("headless") === "1", url.searchParams.get("ended") === "1") });
    if (request.method === "GET" && path === "/api/timeline") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
      return json({ responses: db.timeline(Number.isFinite(limit) ? limit : 100, Number.isFinite(before) ? before : undefined,
        url.searchParams.get("headless") === "1",
        url.searchParams.get("host") ?? "", url.searchParams.get("harness") ?? "") });
    }
    if (request.method === "POST" && path === "/api/seen-all") {
      db.markAllSeen();
      for (const dto of db.listSessions(true,true)) send(dto);
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/api/backfill") return json({ ok: true, ...await runBackfill() });
    const seenMatch = request.method === "POST" && path.match(/^\/api\/sessions\/([^/]+)\/seen$/);
    if (seenMatch) {
      let key: string;
      try { key = decodeURIComponent(seenMatch[1]); } catch { return json({ error: "invalid key" }, 400); }
      const dto = db.markSeen(key);
      if (!dto) return json({ error: "session not found" }, 404);
      send(dto);
      return json({ ok: true, session: dto });
    }
    if (request.method === "GET" && path === "/api/stream") {
      disableTimeout();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(c) { controller = c; clients.add(c); c.enqueue(encoder.encode(": connected\n\n")); },
        cancel() { if (controller) clients.delete(controller); },
      });
      request.signal.addEventListener("abort", () => { if (controller) clients.delete(controller); }, { once: true });
      return new Response(stream, { headers: headers({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }) });
    }
    const file = staticFiles[path];
    if (request.method === "GET" && file) {
      const asset = Bun.file(file[0]);
      if (await asset.exists()) return new Response(asset, { headers: headers({ "Content-Type": file[1] }) });
    }
    return json({ error: "not found" }, 404);
  };
  const hostname = options.hostname ?? process.env.DASH_BIND ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    replies?.close(); clearInterval(heartbeat); db.close();
    throw new Error("DASH_BIND must be a loopback address");
  }
  const server = Bun.serve({
    hostname,
    port: options.port ?? Number(process.env.DASH_PORT ?? 4777),
    fetch: (request, listenerServer) => handle(request, listenerServer.port, () => listenerServer.timeout(request, 0), "loopback"),
  });
  let tailnetServer: typeof server | undefined;
  try {
    if (tailnetPort !== undefined) tailnetServer = Bun.serve({
      hostname: "127.0.0.1", port: tailnetPort,
      fetch: (request, listenerServer) => handle(request, listenerServer.port, () => listenerServer.timeout(request, 0), "tailnet"),
    });
  } catch (error) { replies?.close(); clearInterval(heartbeat); server.stop(true); db.close(); throw error; }
  let livenessTimer: ReturnType<typeof setInterval> | undefined;
  telegram?.start();
  if (decisionsEnabled) for (const id of db.resumablePending(now())) void extraction?.run(id);
  if (options.backfill !== false) void runBackfill();
  if (options.liveness !== false) { void runLiveness(); livenessTimer = setInterval(() => void runLiveness(), 15_000); }
  return {
    server, tailnetServer, db, runBackfill, runLiveness,
    get malformedCount() { return malformed; },
    get rejectedCount() { return rejected; },
    close() { extraction?.close(); telegram?.close(); replies?.close(); clearInterval(heartbeat); if (livenessTimer) clearInterval(livenessTimer); for (const client of clients) try { client.close(); } catch {} clients.clear(); tailnetServer?.stop(true); server.stop(true); db.close(); },
  };
}

if (import.meta.main) {
  const app = createDashServer();
  console.log(`dash listening at http://${app.server.hostname}:${app.server.port}`);
  if (app.tailnetServer) console.log(`dash tailnet listening at http://${app.tailnetServer.hostname}:${app.tailnetServer.port}`);
  process.on("SIGINT", () => { app.close(); process.exit(0); });
  process.on("SIGTERM", () => { app.close(); process.exit(0); });
}

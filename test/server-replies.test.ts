import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDashServer } from "../src/server.ts";
import { localHost } from "../src/normalize.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GO_REC_AUTH_TEXT } from "../src/actions.ts";

type App = ReturnType<typeof createDashServer>;
type Harness = "claude" | "omp";
let app: App | undefined;
let base = "";
let tailnetBase = "";
let nowMs = 1_000_000;
let originalEnv: Record<string, string | undefined>;
const sid = "synthetic_session";
const waiter = "waiteraaaaaaaaaa";
const remoteHeaders = { Host: "dash.tailnet.test", "X-Forwarded-For": "192.0.2.10" };
const envNames = ["DASH_REPLIES", "DASH_ALLOWED_HOSTS", "DASH_ALLOWED_PEERS", "DASH_TAILNET_PORT", "DASH_TG_TOPICS", "DASH_TELEGRAM", "DASH_TELEGRAM_API_BASE", "DASH_JUDGE", "DASH_CODEX_BIN"];

beforeEach(() => {
  originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  process.env.DASH_REPLIES = "";
  process.env.DASH_ALLOWED_HOSTS = "";
  process.env.DASH_ALLOWED_PEERS = "";
  process.env.DASH_TAILNET_PORT = "";
  process.env.DASH_TG_TOPICS = "";
  process.env.DASH_TELEGRAM = "";
  process.env.DASH_TELEGRAM_API_BASE = "";
  process.env.DASH_JUDGE = "";
  process.env.DASH_CODEX_BIN = "";
  nowMs = 1_000_000;
});

afterEach(() => {
  app?.close();
  app = undefined;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function setup(enabled: boolean, options: { hosts?: string; peers?: string; tailnet?: boolean } = {}) {
  process.env.DASH_REPLIES = enabled ? "1" : "";
  process.env.DASH_ALLOWED_HOSTS = options.hosts ?? (options.tailnet ? "dash.tailnet.test" : "");
  process.env.DASH_ALLOWED_PEERS = options.peers ?? (options.tailnet ? "192.0.2.10" : "");
  app = createDashServer({ port: 0, tailnetPort: options.tailnet ? 0 : undefined, dataPath: ":memory:", backfill: false, liveness: false, now: () => nowMs });
  base = `http://127.0.0.1:${app.server.port}`;
  tailnetBase = options.tailnet ? `http://127.0.0.1:${app.tailnetServer!.port}` : "";
  return base;
}

function seed(harness: Harness, host = localHost()) {
  return app!.db.applyEvent({ host, harness, sessionId: sid, kind: "session_start", ts: nowMs, interactive: true });
}

function enqueue(key: string, text: string, source: "web" | "telegram" | "autopilot" = "web", actor = "web:loopback") {
  return app!.db.enqueueReply(key, text, source, actor, undefined, nowMs, 60_000);
}

const waitPath = (harness: Harness, started = nowMs, extra = "") =>
  `/reply/wait/${harness}?session=${sid}&waiter=${waiter}&started=${started}&wait=1${extra}`;
const apiJson = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, {
  method: "POST", headers: { Origin: base, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
const apiReplyPath = (key: string) => `/api/sessions/${encodeURIComponent(key)}/reply`;
const apiCancelPath = (key: string) => `/api/sessions/${encodeURIComponent(key)}/replies/cancel`;
const apiListPath = (key: string) => `/api/sessions/${encodeURIComponent(key)}/replies`;

async function expectExactJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(JSON.stringify(body));
}

async function waitFor(predicate: () => Promise<boolean>, message: string) {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(message);
}

class SseReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}
  async nextFrame() {
    while (true) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator >= 0) {
        const frame = this.buffer.slice(0, separator);
        this.buffer = this.buffer.slice(separator + 2);
        return frame;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("SSE stream closed before the expected event");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
  async close() { await this.reader.cancel(); }
}

async function connectSse(url = `${base}/api/stream`, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("text/event-stream");
  const events = new SseReader(response.body!.getReader());
  expect(await events.nextFrame()).toBe(": connected");
  return events;
}

function parseSse(frame: string) {
  const event = frame.match(/^event: (.+)$/m)?.[1];
  const data = frame.match(/^data: (.+)$/m)?.[1];
  return { event, data: data === undefined ? undefined : JSON.parse(data) as Record<string, unknown> };
}

async function nextReplyEvents(stream: SseReader, count: number) {
  const result: Record<string, unknown>[] = [];
  while (result.length < count) {
    const frame = await Promise.race([
      stream.nextFrame(),
      Bun.sleep(5_000).then(() => { throw new Error("timed out waiting for reply SSE event"); }),
    ]);
    const parsed = parseSse(frame);
    if (parsed.event === "reply" && parsed.data) result.push(parsed.data);
  }
  return result;
}

async function expectNoReplyEvent(stream: SseReader, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const frame = await Promise.race([stream.nextFrame(), Bun.sleep(remaining).then(() => null)]);
    if (frame === null) return;
    expect(parseSse(frame).event).not.toBe("reply");
  }
}

test("reply routes stay disabled and valid 4b writes return the exact not-found response", async () => {
  const baseUrl = setup(false);
  const session = seed("claude");
  expect((await fetch(baseUrl + waitPath("claude"))).status).toBe(404);
  await expectExactJson(await fetch(baseUrl + "/reply/ack", { method: "POST" }), 404, { error: "not found" });
  await expectExactJson(await fetch(baseUrl + "/reply/commit", { method: "POST" }), 404, { error: "not found" });
  await expectExactJson(await apiJson(baseUrl + apiReplyPath(session.key), { text: "synthetic reply" }), 404, { error: "not found" });
  await expectExactJson(await apiJson(baseUrl + apiCancelPath(session.key), {}), 404, { error: "not found" });
  await expectExactJson(await fetch(baseUrl + apiListPath(session.key)), 404, { error: "not found" });
  expect((await (await fetch(baseUrl + "/healthz")).json() as any).replies).toEqual({ enabled: false });
});

test("4b writes check Origin and JSON before the replies flag", async () => {
  const baseUrl = setup(false);
  const session = seed("claude");
  const path = baseUrl + apiReplyPath(session.key);
  await expectExactJson(await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "synthetic" }) }), 403, { error: "forbidden" });
  await expectExactJson(await fetch(path, { method: "POST", headers: { Origin: baseUrl }, body: "{}" }), 415, { error: "unsupported media type" });
  await expectExactJson(await apiJson(path, { text: "synthetic" }), 404, { error: "not found" });
});

test("validates wait parameters and the loopback session label", async () => {
  const baseUrl = setup(true);
  const invalid = [
    waitPath("claude", nowMs, "&wait=56"),
    "/reply/wait/claude?session=x!&waiter=waiteraaaaaaaaaa&started=1&wait=1",
    "/reply/wait/claude?session=x&waiter=short&started=1&wait=1",
    "/reply/wait/claude?session=x&waiter=waiteraaaaaaaaaa&started=no&wait=1",
  ];
  for (const path of invalid) expect((await fetch(baseUrl + path)).status).toBe(400);
  expect((await fetch(baseUrl + waitPath("claude"), { headers: { "X-Dash-Host": "foreign" } })).status).toBe(403);
  await expectExactJson(await fetch(baseUrl + "/reply/ack", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }), 400, { error: "bad request" });
});

test("tailnet reply waits require the mapped host label and time out with 204", async () => {
  const baseUrl = setup(true, { tailnet: true, peers: "mbp=192.0.2.10" });
  const remote = `http://127.0.0.1:${app!.tailnetServer!.port}`;
  const session = seed("claude", "mbp");
  const headers = { ...remoteHeaders, "X-Dash-Host": "mbp" };
  await expectExactJson(await fetch(remote + waitPath("claude"), { headers: { ...headers, "X-Dash-Host": "other" } }), 403, { error: "forbidden" });
  const start = performance.now();
  const response = await fetch(remote + waitPath("claude"), { headers });
  expect(response.status).toBe(204);
  expect(performance.now() - start).toBeGreaterThanOrEqual(900);
  expect(baseUrl).toStartWith("http://127.0.0.1:");
  expect(session.key).toBe("mbp|claude|synthetic_session");
});

test("Claude web reply reaches a waiting session and gives a text-only response", async () => {
  const baseUrl = setup(true);
  const session = seed("claude");
  const pending = fetch(baseUrl + waitPath("claude"));
  await waitFor(async () => (await (await fetch(baseUrl + "/healthz")).json() as any).replies.waiters.claude === 1, "Claude waiter did not register");
  const response = await apiJson(baseUrl + apiReplyPath(session.key), { text: "synthetic owner reply" });
  expect(response.status).toBe(200);
  const result = await response.json() as { ok: boolean; replyId: number };
  expect(result).toMatchObject({ ok: true });
  expect(result.replyId).toBeNumber();
  const delivered = await pending;
  expect(delivered.status).toBe(200);
  expect(delivered.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await delivered.text()).toBe("[dash] The owner replied from the dashboard. Treat this as their next message:\nsynthetic owner reply");
  expect(app!.db.getReply(result.replyId)).toMatchObject({ state: "delivered", source: "web", text: "" });
});

test("OMP ask replies accept only the exact pending question identity", async () => {
  nowMs = Date.now();
  const baseUrl = setup(true);
  const session = seed("omp");
  const questions = [
    { id: "synthetic-choice", question: "Choose a synthetic route?", options: [
      { label: "1. Synthetic option one" }, { label: "3. Synthetic option three" }, { label: "4. Synthetic option four" },
    ], recommended: 1 },
    { id: "synthetic-multi", question: "Choose synthetic flags?", options: [{ label: "Alpha" }, { label: "Beta" }], multi: true },
  ];
  const first = app!.db.applyEvent({ host: localHost(), harness: "omp", sessionId: sid, kind: "question",
    questionIdentity: "question_identity_one", questionData: questions, ts: ++nowMs, text: "Choose synthetic options?", interactive: true });
  expect(first.turnSeq).toBe(session.turnSeq);
  expect(first.lastResponses).toHaveLength(0);
  expect(first.pendingQuestion).toMatchObject({ id: "question_identity_one", questions });
  const accepted = await apiJson(baseUrl + apiReplyPath(session.key), {
    text: "1. Synthetic option one", answersQuestion: "question_identity_one",
  });
  expect(accepted.status).toBe(200);
  const { replyId } = await accepted.json() as { replyId: number };
  expect(app!.db.getReply(replyId)).toMatchObject({ answersTurn: null, answersQuestion: "question_identity_one" });

  const replacement = app!.db.applyEvent({ host: localHost(), harness: "omp", sessionId: sid, kind: "question",
    questionIdentity: "question_identity_two", questionData: questions, ts: ++nowMs, text: "Choose another synthetic option?", interactive: true });
  expect(replacement.turnSeq).toBe(session.turnSeq);
  await expectExactJson(await apiJson(baseUrl + apiReplyPath(session.key), {
    text: "stale synthetic choice", answersQuestion: "question_identity_one",
  }), 409, { refused: true, reason: "stale_question" });
  const current = await apiJson(baseUrl + apiReplyPath(session.key), {
    text: "3. Synthetic option three", answersQuestion: "question_identity_two",
  });
  expect(current.status).toBe(200);
  app!.db.applyEvent({ host: localHost(), harness: "omp", sessionId: sid, kind: "question_answered",
    questionIdentity: "question_identity_two", ts: ++nowMs, interactive: true });
  await expectExactJson(await apiJson(baseUrl + apiReplyPath(session.key), {
    text: "ended synthetic choice", answersQuestion: "question_identity_two",
  }), 409, { refused: true, reason: "stale_question" });
  app!.db.applyEvent({ host: localHost(), harness: "omp", sessionId: sid, kind: "session_end", ts: ++nowMs, interactive: true });
  await expectExactJson(await apiJson(baseUrl + apiReplyPath(session.key), {
    text: "synthetic choice after session end", answersQuestion: "question_identity_two",
  }), 409, { refused: true, reason: "session_ended" });
});

test("web Rec auth'd action is turn-bound and refused when stale or not deliverable", async () => {
  const baseUrl = setup(true);
  const session = seed("claude");
  const turn = session.turnSeq;
  const response = await apiJson(baseUrl + apiReplyPath(session.key), { text: GO_REC_AUTH_TEXT, answersTurn: turn });
  expect(response.status).toBe(200);
  const { replyId } = await response.json() as { replyId: number };
  expect(app!.db.getReply(replyId)).toMatchObject({ source: "web", answersTurn: turn, text: GO_REC_AUTH_TEXT });
  const before = app!.db.replyCounts();
  await expectExactJson(await apiJson(baseUrl + apiReplyPath(session.key), { text: GO_REC_AUTH_TEXT, answersTurn: turn + 1 }),
    409, { refused: true, reason: "stale_turn" });
  app!.db.sqlite.query("UPDATE sessions SET status='needs_input', needs_reason='waiting' WHERE key=?").run(session.key);
  await expectExactJson(await apiJson(baseUrl + apiReplyPath(session.key), { text: GO_REC_AUTH_TEXT, answersTurn: turn }),
    409, { refused: true, reason: "not_deliverable" });
  expect(app!.db.replyCounts()).toEqual(before);
});

// The dashboard's pure wording helpers, taken verbatim from app.js so the payload is tested without a DOM.
const dashboardChoice = (() => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  return new Function(`${script.slice(script.indexOf("  const flatText"), script.indexOf("  const postJson"))}; return dashboardChoice;`)() as
    (decisions: unknown[], picks: Map<number, number>) => string;
})();

test("dashboard decision payload is the exact R6 wording and stays turn-bound", async () => {
  const baseUrl = setup(true);
  const text = "Two calls to make:\n\n1. Master direction?\n   A. keep the plan\n   B. use the alternate plan (my pick)\n2. Grok?\n   A. fetch by direct link\n   B. skip";
  const dto = app!.db.applyEvent({ host: localHost(), harness: "claude", sessionId: sid, kind: "response", ts: nowMs, text, interactive: true });
  const session = (await (await fetch(baseUrl + "/api/sessions")).json() as any).sessions[0];
  const current = session.lastResponses.find((r: any) => r.turnSeq === session.turnSeq);
  expect(current.decisionState).toBe("parser");
  expect(current.recommendation).toBe("use the alternate plan (my pick)");
  const { decisions } = current.decisions;
  expect(dashboardChoice(decisions, new Map([[1, 1]]))).toBe(
    '[dash] The owner chose (via dashboard): 1. Master direction? → your recommendation ("use the alternate plan"). 2. Grok? → B ("skip").');
  expect(dashboardChoice(decisions, new Map())).toBe(
    '[dash] The owner chose (via dashboard): 1. Master direction? → your recommendation ("use the alternate plan"). 2. Grok? → your call.');
  const choice = dashboardChoice(decisions, new Map([[0, 0], [1, 0]]));
  expect(choice).toBe('[dash] The owner chose (via dashboard): 1. Master direction? → A ("keep the plan"). 2. Grok? → A ("fetch by direct link").');
  const response = await apiJson(baseUrl + apiReplyPath(dto.key), { text: choice, answersTurn: session.turnSeq });
  expect(response.status).toBe(200);
  const { replyId } = await response.json() as { replyId: number };
  expect(app!.db.getReply(replyId)).toMatchObject({ source: "web", answersTurn: session.turnSeq, text: choice });
  const before = app!.db.replyCounts();
  await expectExactJson(await apiJson(baseUrl + apiReplyPath(dto.key), { text: choice, answersTurn: session.turnSeq - 1 }), 409, { refused: true, reason: "stale_turn" });
  expect(app!.db.replyCounts()).toEqual(before);
});

const currentTurnResponse = (() => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  const helper = script.slice(script.indexOf("  const currentTurnResponse"), script.indexOf("  // R6 owner wording with the dashboard prefix"));
  return new Function(`${script.slice(script.indexOf("  const byId"), script.indexOf("  const esc"))}${helper}; return currentTurnResponse;`)() as
    (responses: unknown[], turnSeq: number) => { id: number } | undefined;
})();

test("dashboard quick actions bind only to the latest response of the current turn", async () => {
  const baseUrl = setup(true);
  const event = (kind: "prompt" | "response" | "error", text?: string) =>
    app!.db.applyEvent({ host: localHost(), harness: "claude", sessionId: sid, kind, ts: ++nowMs, text, interactive: true });
  const current = async () => {
    const session = (await (await fetch(baseUrl + "/api/sessions")).json() as any).sessions[0];
    return { session, picked: currentTurnResponse(session.lastResponses, session.turnSeq) };
  };
  event("response", "Should I delete the old branch?");
  let { session, picked } = await current();
  expect(picked?.id).toBe(session.lastResponses[0].id);
  // A failed turn advances turnSeq with no response row: the shown ask is the previous turn's.
  event("prompt", "no, do the other thing");
  event("error", "StopFailure");
  ({ session, picked } = await current());
  expect([session.status, session.turnSeq, session.lastResponses[0].turnSeq]).toEqual(["your_turn", 2, 1]);
  expect(picked).toBeUndefined();
  // A newer backfilled message (turn NULL) shadows the hook row of the current turn: nothing is live.
  event("response", "Which DB?\n1. Postgres (my pick)\n2. SQLite");
  ({ session, picked } = await current());
  expect(picked?.id).toBe(session.lastResponses[0].id);
  app!.db.addBackfill({ host: localHost(), harness: "claude", sessionId: sid, interactive: true,
    responses: [{ ts: ++nowMs + 10_000, text: "Deploy step: drop the table or keep it?\nA. drop it\nB. keep it" }] } as any);
  ({ session, picked } = await current());
  expect([session.turnSeq, session.lastResponses[0].turnSeq, session.lastResponses[1].turnSeq]).toEqual([3, null, 3]);
  expect(picked).toBeUndefined();
});

test("dashboard labels with quotes and newlines stay inside their clause", () => {
  const decisions = [{ title: "Pick\none", options: [{ key: "A", label: 'say "hi"\nthen <img src=x onerror=alert(1)>' }, { key: "B", label: "b" }], recIndex: null, recQuote: null }];
  expect(dashboardChoice(decisions, new Map([[0, 0]]))).toBe(
    '[dash] The owner chose (via dashboard): 1. Pick one → A ("say \\"hi\\" then <img src=x onerror=alert(1)>").');
});

test("the recommendation quote is absent from response DTOs with replies off", async () => {
  const baseUrl = setup(false);
  app!.db.applyEvent({ host: localHost(), harness: "claude", sessionId: sid, kind: "response", ts: nowMs, text: "I'd go with sqlite. Should I?", interactive: true });
  const session = (await (await fetch(baseUrl + "/api/sessions")).json() as any).sessions[0];
  expect(session.lastResponses[0]).not.toHaveProperty("recommendation");
  expect(session.lastResponses[0].decisionState).toBe("skipped");
});

test("encoded session keys return only the public reply DTO and malformed paths write nothing", async () => {
  const baseUrl = setup(true);
  const session = seed("claude");
  const response = await apiJson(baseUrl + apiReplyPath(session.key), { text: "synthetic private owner text" });
  expect(response.status).toBe(200);
  const { replyId } = await response.json() as { replyId: number };

  const listed = await fetch(baseUrl + apiListPath(session.key));
  expect(listed.status).toBe(200);
  const body = await listed.json() as { replies: Record<string, unknown>[] };
  expect(body.replies).toHaveLength(1);
  expect(body.replies[0]).toMatchObject({ id: replyId, source: "web", state: "queued", committed: false });
  expect(Object.keys(body.replies[0]).sort()).toEqual([
    "answersTurn", "cancelReason", "committed", "createdAt", "doneAt", "expiresAt", "id", "source", "state",
  ]);
  const publicText = JSON.stringify(body);
  expect(publicText).not.toContain("synthetic private owner text");
  expect(publicText).not.toContain("web:loopback");

  const before = app!.db.replyCounts();
  await expectExactJson(await apiJson(baseUrl + "/api/sessions/%E0%A4%A/reply", { text: "synthetic rejected text" }), 400, { error: "invalid key" });
  const missingKey = "synthetic-host|claude|missing_session";
  const missingReply = await apiJson(baseUrl + apiReplyPath(missingKey), { text: "synthetic missing-session text" });
  expect(missingReply.status).toBe(404);
  expect((await fetch(baseUrl + apiListPath(missingKey))).status).toBe(404);
  expect((await apiJson(baseUrl + apiCancelPath(missingKey), {})).status).toBe(404);
  expect(app!.db.replyCounts()).toEqual(before);
});

test("reply cancellation includes queued and uncommitted leased replies", async () => {
  const baseUrl = setup(true);
  const session = seed("omp");
  const first = await apiJson(baseUrl + apiReplyPath(session.key), { text: "synthetic leased reply" });
  expect(first.status).toBe(200);
  const { replyId: leasedId } = await first.json() as { replyId: number };
  const leasedResponse = await fetch(baseUrl + waitPath("omp", nowMs, "&commit=1"));
  expect(leasedResponse.status).toBe(200);
  expect(await leasedResponse.json()).toMatchObject({ id: leasedId, text: "synthetic leased reply", source: "web" });

  const second = await apiJson(baseUrl + apiReplyPath(session.key), { text: "synthetic queued reply" });
  expect(second.status).toBe(200);
  const { replyId: queuedId } = await second.json() as { replyId: number };
  expect(app!.db.getReply(leasedId)?.state).toBe("leased");
  expect(app!.db.getReply(queuedId)?.state).toBe("queued");

  const response = await apiJson(baseUrl + apiCancelPath(session.key), {});
  await expectExactJson(response, 200, { ok: true, cancelled: 2 });
  expect(app!.db.getReply(leasedId)).toMatchObject({ state: "cancelled", cancelReason: "owner_cancelled", text: "" });
  expect(app!.db.getReply(queuedId)).toMatchObject({ state: "cancelled", cancelReason: "owner_cancelled", text: "" });
});

test("cancelling a reply id never cancels a different session's reply", async () => {
  const baseUrl = setup(true);
  const first = seed("claude");
  const second = app!.db.applyEvent({ host: localHost(), harness: "claude", sessionId: "other_session", kind: "session_start", ts: nowMs + 1, interactive: true });
  const created = await apiJson(baseUrl + apiReplyPath(second.key), { text: "synthetic other-session reply" });
  const { replyId } = await created.json() as { replyId: number };
  const response = await apiJson(baseUrl + apiCancelPath(first.key), { id: replyId });
  await expectExactJson(response, 200, { ok: true, cancelled: 0 });
  expect(app!.db.getReply(replyId)).toMatchObject({ state: "queued", text: "synthetic other-session reply" });
  expect((await apiJson(baseUrl + apiCancelPath(first.key), { id: 0 })).status).toBe(400);
});

test("SSE emits queued before one immediate Claude delivery with a four-field DTO", async () => {
  const baseUrl = setup(true);
  const session = seed("claude");
  const stream = await connectSse();
  const pending = fetch(baseUrl + waitPath("claude"));
  await waitFor(async () => (await (await fetch(baseUrl + "/healthz")).json() as any).replies.waiters.claude === 1, "Claude waiter did not register");
  try {
    const response = await apiJson(baseUrl + apiReplyPath(session.key), { text: "synthetic SSE private text" });
    expect(response.status).toBe(200);
    const { replyId } = await response.json() as { replyId: number };
    expect((await pending).status).toBe(200);
    const events = await nextReplyEvents(stream, 2);
    expect(events.map(event => event.state)).toEqual(["queued", "delivered"]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(["key", "replyId", "source", "state"]);
      expect(event).toMatchObject({ key: session.key, replyId, source: "web" });
    }
    expect(JSON.stringify(events)).not.toContain("synthetic SSE private text");
    await expectNoReplyEvent(stream);
  } finally { await stream.close(); }
});

test("repeated OMP ack emits one terminal SSE event", async () => {
  const baseUrl = setup(true);
  const session = seed("omp");
  const stream = await connectSse();
  const pending = fetch(baseUrl + waitPath("omp", nowMs, "&commit=1"));
  await waitFor(async () => (await (await fetch(baseUrl + "/healthz")).json() as any).replies.waiters.omp === 1, "OMP waiter did not register");
  try {
    const submitted = await apiJson(baseUrl + apiReplyPath(session.key), { text: "synthetic OMP SSE text" });
    expect(submitted.status).toBe(200);
    const { replyId } = await submitted.json() as { replyId: number };
    const lease = await pending;
    expect(lease.status).toBe(200);
    expect(await lease.json()).toMatchObject({ id: replyId, source: "web" });

    await expectExactJson(await fetch(baseUrl + "/reply/commit", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: replyId, waiter }) }), 200, { ok: true });
    const ack = () => fetch(baseUrl + "/reply/ack", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: replyId, waiter, outcome: "sent" }) });
    await expectExactJson(await ack(), 200, { ok: true });
    await expectExactJson(await ack(), 200, { ok: true });

    const events = await nextReplyEvents(stream, 2);
    expect(events.map(event => event.state)).toEqual(["queued", "delivered"]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(["key", "replyId", "source", "state"]);
      expect(event).toMatchObject({ key: session.key, replyId, source: "web" });
    }
    expect(JSON.stringify(events)).not.toContain("synthetic OMP SSE text");
    await expectNoReplyEvent(stream);
  } finally { await stream.close(); }
});

test("OMP commit is peer-bound and legacy waiters can still acknowledge without commit", async () => {
  const baseUrl = setup(true, { tailnet: true, peers: "mbp=192.0.2.10,mbp=192.0.2.11" });
  const remote = tailnetBase;
  const session = seed("omp", "mbp");
  const tailHeaders = (peer: string, label = "mbp") => ({ Host: "dash.tailnet.test", "X-Forwarded-For": peer, "X-Dash-Host": label });
  const legacy = enqueue(session.key, "synthetic legacy text");
  const legacyWait = await fetch(remote + waitPath("omp"), { headers: tailHeaders("192.0.2.10") });
  expect(legacyWait.status).toBe(200);
  expect(await legacyWait.json()).toMatchObject({ id: legacy.id, text: "synthetic legacy text", source: "web" });
  expect((app!.db.sqlite.query("SELECT lease_commit FROM replies WHERE id=?").get(legacy.id) as any).lease_commit).toBe(0);
  const legacyAck = await fetch(remote + "/reply/ack", { method: "POST", headers: { ...tailHeaders("192.0.2.10"), "Content-Type": "application/json" },
    body: JSON.stringify({ id: legacy.id, waiter, outcome: "sent" }) });
  await expectExactJson(legacyAck, 200, { ok: true });
  expect(app!.db.getReply(legacy.id)).toMatchObject({ state: "delivered", text: "" });

  const commitCapable = enqueue(session.key, "synthetic commit-capable text");
  const boundWait = await fetch(remote + waitPath("omp", nowMs, "&commit=1"), { headers: tailHeaders("192.0.2.10") });
  expect(boundWait.status).toBe(200);
  expect(await boundWait.json()).toMatchObject({ id: commitCapable.id, text: "synthetic commit-capable text", source: "web" });
  expect((app!.db.sqlite.query("SELECT lease_commit FROM replies WHERE id=?").get(commitCapable.id) as any).lease_commit).toBe(1);

  const wrongPeerCommit = await fetch(remote + "/reply/commit", { method: "POST", headers: { ...tailHeaders("192.0.2.11"), "Content-Type": "application/json" },
    body: JSON.stringify({ id: commitCapable.id, waiter }) });
  await expectExactJson(wrongPeerCommit, 409, { error: "not deliverable" });
  const wrongLabelCommit = await fetch(remote + "/reply/commit", { method: "POST", headers: { ...tailHeaders("192.0.2.10", "other"), "Content-Type": "application/json" },
    body: JSON.stringify({ id: commitCapable.id, waiter }) });
  expect(wrongLabelCommit.status).toBe(403);
  const wrongWaiter = await fetch(remote + "/reply/commit", { method: "POST", headers: { ...tailHeaders("192.0.2.10"), "Content-Type": "application/json" },
    body: JSON.stringify({ id: commitCapable.id, waiter: "otherwaiteraaa" }) });
  await expectExactJson(wrongWaiter, 409, { error: "not deliverable" });

  const commitHeaders = { ...tailHeaders("192.0.2.10"), "Content-Type": "application/json" };
  const commitBody = JSON.stringify({ id: commitCapable.id, waiter });
  await expectExactJson(await fetch(remote + "/reply/commit", { method: "POST", headers: commitHeaders, body: commitBody }), 200, { ok: true });
  await expectExactJson(await fetch(remote + "/reply/commit", { method: "POST", headers: commitHeaders, body: commitBody }), 200, { ok: true });
  const wrongPeerAck = await fetch(remote + "/reply/ack", { method: "POST", headers: { ...tailHeaders("192.0.2.11"), "Content-Type": "application/json" },
    body: JSON.stringify({ id: commitCapable.id, waiter, outcome: "sent" }) });
  await expectExactJson(wrongPeerAck, 404, { error: "not found" });
  await expectExactJson(await fetch(remote + "/reply/ack", { method: "POST", headers: commitHeaders,
    body: JSON.stringify({ id: commitCapable.id, waiter, outcome: "sent" }) }), 200, { ok: true });
  expect(app!.db.getReply(commitCapable.id)).toMatchObject({ state: "delivered", text: "" });
});

test("tailnet browser actor comes from the mapped peer label, including legacy bare-IP peers", async () => {
  const baseUrl = setup(true, { tailnet: true, peers: "mbp=192.0.2.10" });
  const session = seed("claude", "mbp");
  const headers = { Host: "dash.tailnet.test", "X-Forwarded-For": "192.0.2.10", Origin: "https://dash.tailnet.test", "Content-Type": "application/json" };
  const response = await fetch(tailnetBase + apiReplyPath(session.key), { method: "POST", headers, body: JSON.stringify({ text: "synthetic mapped-label reply" }) });
  expect(response.status).toBe(200);
  expect(app!.db.sqlite.query("SELECT source, actor, listener FROM reply_audit ORDER BY id DESC LIMIT 1").get()).toEqual({ source: "web", actor: "web:mbp", listener: "tailnet" });

  app!.close();
  process.env.DASH_ALLOWED_PEERS = "192.0.2.10";
  app = createDashServer({ port: 0, tailnetPort: 0, dataPath: ":memory:", backfill: false, liveness: false, now: () => nowMs });
  const baseBare = `http://127.0.0.1:${app.tailnetServer!.port}`;
  const bareSession = app.db.applyEvent({ host: "any-valid-host", harness: "claude", sessionId: sid, kind: "session_start", ts: nowMs, interactive: true });
  const bare = await fetch(baseBare + apiReplyPath(bareSession.key), { method: "POST", headers, body: JSON.stringify({ text: "synthetic legacy-peer reply" }) });
  expect(bare.status).toBe(200);
  expect(app.db.sqlite.query("SELECT actor, listener FROM reply_audit ORDER BY id DESC LIMIT 1").get()).toEqual({ actor: "web:tailnet-peer-192-0-2-10", listener: "tailnet" });
});

test("flag-off reply routes do not emit reply SSE events", async () => {
  const baseUrl = setup(false);
  const session = seed("claude");
  const stream = await connectSse();
  try {
    await expectExactJson(await apiJson(baseUrl + apiReplyPath(session.key), { text: "synthetic disabled reply" }), 404, { error: "not found" });
    await expectNoReplyEvent(stream);
  } finally { await stream.close(); }
});

test("the dashboard recommendation quote is redacted like the Telegram line", async () => {
  const baseUrl = setup(true);
  app!.db.applyEvent({ host: localHost(), harness: "claude", sessionId: sid, kind: "response", ts: nowMs, interactive: true,
    text: "Which credential should the job use? I recommend the scoped one, token=aaaabbbbcccc, for the deploy." });
  const session = (await (await fetch(baseUrl + "/api/sessions")).json() as any).sessions[0];
  expect(session.lastResponses[0].recommendation).toBe("I recommend the scoped one, token=[redacted] for the deploy.");
});

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashDB, type SessionDTO } from "../src/db.ts";
import { createTelegram, redact } from "../src/telegram.ts";
import { createReplies } from "../src/replies.ts";
import { createDashServer } from "../src/server.ts";
import { CONTINUE_LABEL, CONTINUE_TEXT } from "../src/actions.ts";
import { validateDecisionSet } from "../src/decisions.ts";

import type { AskQuestion } from "../src/normalize.ts";
const token = `123456789:${"A".repeat(32)}`;
const owner = 712345;
const chat = 812345;
const group = -100812345;
const defaultTopics = { invest: 42, general: null, "squad/rogue": 74, urgent: 90, defense: 56 };
const ok = (result: unknown = true) => ({ ok: true, result });
type Call = { method: string; body: Record<string, any> };

class FakeBot {
  readonly calls: Call[] = [];
  readonly sent: Record<string, any>[] = [];
  readonly sendTimes: number[] = [];
  readonly server: ReturnType<typeof Bun.serve>;
  now = () => Date.now();
  webhook = "";
  nextPollStatus: number | undefined;
  nextSend: { status: number; body: unknown } | undefined;
  sendSequence: { status: number; body: unknown }[] = [];
  editSequence: { status: number; body: unknown }[] = [];
  beforeEdit?: () => Promise<void>;
  nextCallbackAnswer: { status: number; body: unknown } | undefined;
  private updates: Record<string, any>[] = [];
  private pending: { resolve: (updates: Record<string, any>[]) => void; offset: number } | undefined;
  private nextId = 1;
  constructor() {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => {
      const method = new URL(request.url).pathname.split("/").at(-1)!;
      const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, any> : Object.fromEntries(new URL(request.url).searchParams);
      this.calls.push({ method, body });
      if (method === "getMe") return Response.json(ok({ id: 1, is_bot: true, username: "dash_test_bot" }));
      if (method === "getWebhookInfo") return Response.json(ok({ url: this.webhook }));
      if (method === "getUpdates") {
        if (this.nextPollStatus) {
          const status = this.nextPollStatus;
          this.nextPollStatus = undefined;
          return Response.json({ ok: false, error_code: status, description: "synthetic" }, { status });
        }
        const offset = Number(body.offset ?? 0);
        const ready = this.updates.filter(update => update.update_id >= offset);
        if (ready.length) return Response.json(ok(ready));
        const updates = await new Promise<Record<string, any>[]>(resolve => {
          this.pending = { resolve, offset };
          request.signal.addEventListener("abort", () => { if (this.pending?.resolve === resolve) this.pending = undefined; resolve([]); }, { once: true });
        });
        return Response.json(ok(updates));
      }
      if (method === "sendMessage") {
        this.sent.push(body);
        this.sendTimes.push(this.now());
        const response = this.sendSequence.shift() ?? this.nextSend;
        if (response) {
          if (response === this.nextSend) this.nextSend = undefined;
          return Response.json(response.body, { status: response.status });
        }
        return Response.json(ok({ message_id: this.sent.length }));
      }
      if (method === "editMessageText") {
        await this.beforeEdit?.();
        const response = this.editSequence.shift();
        return response ? Response.json(response.body, { status: response.status }) : Response.json(ok({ message_id: body.message_id }));
      }
      if (method === "editMessageReplyMarkup") return Response.json(ok(true));
      if (method === "deleteMessage") return Response.json(ok(true));
      if (method === "answerCallbackQuery") {
        if (this.nextCallbackAnswer) {
          const response = this.nextCallbackAnswer;
          this.nextCallbackAnswer = undefined;
          return Response.json(response.body, { status: response.status });
        }
        return Response.json(ok());
      }
      return Response.json({ ok: false, error_code: 404 }, { status: 404 });
    } });
  }
  get base() { return `http://127.0.0.1:${this.server.port}`; }
  count(method: string) { return this.calls.filter(call => call.method === method).length; }
  enqueue(message: Record<string, any>) { this.enqueueUpdate({ message }); }
  enqueueUpdate(update: Record<string, any>) {
    const item = { update_id: this.nextId++, ...update };
    this.updates.push(item);
    if (this.pending && item.update_id >= this.pending.offset) {
      const { resolve, offset } = this.pending;
      this.pending = undefined;
      resolve(this.updates.filter(update => update.update_id >= offset));
    }
  }
  close() { this.pending?.resolve([]); this.pending = undefined; this.server.stop(true); }
}

const message = (text: string, overrides: Record<string, any> = {}) => ({
  message_id: 10, text, date: 1, from: { id: owner, username: "synthetic_owner" },
  chat: { id: chat, type: "private" }, ...overrides,
});
const dto = (status: SessionDTO["status"], overrides: Partial<SessionDTO> = {}): SessionDTO => ({
  key: "synthetic-host|claude|session-1", host: "synthetic-host", harness: "claude", sessionId: "session-1",
  displayName: "Project <one>", project: "project", status, needsReason: status === "needs_input" ? "question" : undefined,
  needsText: status === "needs_input" ? "Can I use <this> & that?" : undefined, backgroundPending: false,
  interactive: true, alive: true, createdAt: 1, lastActivity: 1, unreadCount: 0, lastResponses: [], ...overrides,
});
async function eventually(check: () => boolean, label = "condition") {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Bot API calls (other than the long poll) whose response body the client has not yet received. Once a call's body
// is read, the client's remaining work for that response (card activation, alert registration) runs in microtasks,
// so a check made from eventually()'s timer with nothing in flight sees the client's state for every response so far.
let apiInFlight = new Set<object>();
const trackedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const calls = apiInFlight, call = {};
  if (!String(input).endsWith("/getUpdates")) calls.add(call);
  try {
    const response = await fetch(input, init);
    const text = await response.text();
    return { ok: response.ok, status: response.status, json: async () => JSON.parse(text) } as unknown as Response;
  } finally { calls.delete(call); }
}) as typeof fetch;
// Waits for a Bot API side effect (usually a send count) and for the client to have processed every response.
const apiSettled = (check: () => boolean, label = "Bot API calls settled") => eventually(() => check() && apiInFlight.size === 0, label);

const resources: Array<() => void> = [];
afterEach(() => { while (resources.length) resources.pop()!(); apiInFlight = new Set(); });
function fixture(options: { paired?: boolean; webhook?: string; clock?: { now: number }; sleep?: (ms: number) => Promise<void>; token?: string | undefined; snippetChars?: number; mode?: "input" | "turns" | "off"; seededQuestion?: boolean; pollStatus?: number; reportError?: (area: string, error: unknown) => void; repliesEnabled?: boolean; ttlMs?: number; topicsEnabled?: boolean; bindings?: { groupChatId: string; topics: Record<string, number | null> }; setTimer?: (fn: () => void, ms: number) => () => void; decisionsEnabled?: boolean; judgeEnabled?: boolean; observeReplies?: boolean; db?: DashDB } = {}) {
  const topicsEnabled = options.topicsEnabled ?? false;
  const db = options.db ?? new DashDB(":memory:", { topicsEnabled, decisionsEnabled: options.decisionsEnabled, judgeEnabled: options.judgeEnabled });
  const bot = new FakeBot();
  if (options.paired) { db.setSetting("telegram.chat_id", String(chat)); db.setSetting("telegram.user_id", String(owner)); }
  if (options.mode) db.setSetting("telegram.mode", options.mode);
  if (options.bindings) db.setSetting("telegram.topics", JSON.stringify(options.bindings));
  if (options.seededQuestion) db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "session-1", kind: "question", ts: 1, text: "Prior question", interactive: true });
  if (options.webhook) bot.webhook = options.webhook;
  if (options.pollStatus) bot.nextPollStatus = options.pollStatus;
  const clock = options.clock ?? { now: 1_000_000 };
  bot.now = () => clock.now;
  let telegram: ReturnType<typeof createTelegram>;
  const replies = options.repliesEnabled ? createReplies({ db, now: () => clock.now, ttlMs: options.ttlMs ?? 1000,
    setTimer: () => () => {}, onOutcome: (item, outcome, row) => telegram.replyOutcome(item, outcome, row, 1),
    // As in the server: a delivered reply's synthetic prompt reaches Telegram as a prompt event.
    send: options.observeReplies ? (dto, kind) => telegram.observe(dto, kind) : undefined }) : undefined;
  telegram = createTelegram({ db, apiBase: bot.base, fetch: trackedFetch, now: () => clock.now, replies, topicsEnabled, setTimer: options.setTimer,
    readToken: async () => options.token === undefined ? token : options.token,
    sleep: options.sleep ?? (async ms => { clock.now += ms; }), snippetChars: options.snippetChars, reportError: options.reportError });
  resources.push(() => { telegram.close(); replies?.close(); bot.close(); db.close(); });
  telegram.start();
  return { db, bot, telegram, clock, replies };
}
async function pairedFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture({ ...options, paired: true });
  await eventually(() => f.telegram.health().state === "ok", "paired poller");
  return f;
}
async function topicFixture(options: Omit<Parameters<typeof fixture>[0], "topicsEnabled"> = {}) {
  return pairedFixture({ ...options, topicsEnabled: true, bindings: options.bindings ?? { groupChatId: String(group), topics: defaultTopics } });
}
function registerClaudeQuestion(f: Awaited<ReturnType<typeof pairedFixture>>, sessionId: string, questions: AskQuestion[], observe = true) {
  const id = Buffer.alloc(32, sessionId.length).toString("base64url"), toolUseId = `tool-${sessionId}`;
  const event: Parameters<NonNullable<typeof f.replies>["registerQuestion"]>[0]["event"] = {
    host: "synthetic-host", harness: "claude", sessionId, kind: "question", ts: f.clock.now, interactive: true,
    toolUseId, questionData: questions,
  };
  const result = f.replies!.registerQuestion({ event, id, toolUseId, timeoutMs: 60_000 });
  if (!("ok" in result)) throw new Error(`question registration refused: ${result.reason}`);
  const key = `synthetic-host|claude|${sessionId}`;
  f.db.sqlite.query("UPDATE sessions SET alive=1 WHERE key=?").run(key);
  const row = f.db.getSession(key);
  if (!row) throw new Error("registered question session is missing");
  if (observe) f.telegram.observe(row, "question");
  return { id, key, toolUseId };
}
const groupMessage = (text: string, threadId?: number, overrides: Record<string, any> = {}) => message(text, {
  chat: { id: group, type: "supergroup", title: "Ops <group>" },
  ...(threadId === undefined ? {} : { message_thread_id: threadId }), ...overrides,
});
const sendCalls = (bot: FakeBot) => bot.calls.filter(call => call.method === "sendMessage");
const visibleText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name: string) => {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
  return entities[name]!;
});
const shortId = (key: string) => createHash("sha1").update(key).digest("hex").slice(0, 12);
function seedTopicQuestion(db: DashDB, name: string, project: string, ts: number) {
  const row = db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: name,
    cwd: `/projects/${project}/synthetic`, title: `Session ${name}`,
    kind: "question", ts, text: "Synthetic question", interactive: true });
  db.sqlite.query("UPDATE sessions SET needs_reason='waiting',display_name=? WHERE key=?").run(`Session ${name}`, row.key);
  return db.getSession(row.key)!;
}

describe("Telegram startup and polling", () => {
  test("reports no_token while token is unavailable and retries after 60 seconds", async () => {
    const delays: number[] = [];
    const f = fixture({ token: "invalid", sleep: async ms => { delays.push(ms); return new Promise(() => {}); } });
    await eventually(() => f.telegram.health().state === "no_token");
    expect(delays).toContain(60_000);
    expect(f.bot.calls).toHaveLength(0);
  });
  test("refuses to poll when the bot has an existing webhook", async () => {
    const f = fixture({ webhook: "https://example.invalid/hook" });
    await eventually(() => f.telegram.health().state === "webhook_conflict");
    expect(f.bot.count("getUpdates")).toBe(0);
    expect(f.bot.count("deleteWebhook")).toBe(0);
  });
  test("backs off for ten minutes after another poller returns 409", async () => {
    const delays: number[] = [];
    const f = fixture({ paired: true, pollStatus: 409, sleep: async ms => { delays.push(ms); return new Promise(() => {}); } });
    await eventually(() => f.telegram.health().state === "poll_conflict");
    expect(f.bot.count("getUpdates")).toBe(1);
    expect(delays).toContain(600_000);
  });
  test("marks a rejected token bad and waits 60 seconds before reloading", async () => {
    const delays: number[] = [];
    const f = fixture({ paired: true, pollStatus: 401, sleep: async ms => { delays.push(ms); return new Promise(() => {}); } });
    await eventually(() => f.telegram.health().state === "bad_token");
    expect(delays).toContain(60_000);
    expect(f.bot.count("getUpdates")).toBe(1);
  });
  test("uses a two-second retry after a server error", async () => {
    const delays: number[] = [];
    const f = fixture({ paired: true, pollStatus: 503, sleep: async ms => { delays.push(ms); return new Promise(() => {}); } });
    await eventually(() => delays.includes(2_000));
    expect(f.telegram.health().state).toBe("error");
  });
  test("persists the next update offset after a processed message", async () => {
    const f = await pairedFixture();
    f.bot.enqueue(message("/help"));
    await eventually(() => f.db.getSetting("telegram.offset") === "2", "stored offset");
    expect(f.bot.calls.find(call => call.method === "getUpdates")?.body).toMatchObject({ timeout: 50, allowed_updates: ["message", "callback_query"] });
  });
  test("advances after a callback-answer failure without poll backoff or unmuting the session", async () => {
    const reports: string[] = [], delays: number[] = [];
    const f = await pairedFixture({ reportError: area => reports.push(area), sleep: async ms => { delays.push(ms); } });
    const row = f.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "session-1", kind: "question", ts: f.clock.now, text: "Question", interactive: true });
    f.telegram.observe(row);
    await apiSettled(() => f.bot.sent.length === 1);
    const id = f.bot.sent[0].reply_markup.inline_keyboard[0][0].callback_data;
    f.bot.nextCallbackAnswer = { status: 400, body: { ok: false, error_code: 400, description: "synthetic" } };
    f.bot.enqueueUpdate({ callback_query: { id: "cb1", from: { id: owner }, message: { chat: { id: chat, type: "private" } }, data: id } });

    await eventually(() => f.db.getSetting("telegram.offset") === "2", "callback offset");
    await eventually(() => f.bot.calls.some(call => call.method === "getUpdates" && call.body.offset === 2), "next poll offset");
    f.telegram.observe({ ...row, status: "working" });
    f.telegram.observe(row);

    expect(f.bot.calls.find(call => call.method === "answerCallbackQuery")?.body.text).toContain("Muted");
    expect(f.bot.count("answerCallbackQuery")).toBe(1);
    expect(f.bot.sent).toHaveLength(1);
    expect(reports).toEqual(["telegram callback"]);
    expect(delays).toEqual([]);
    expect(f.telegram.health().state).toBe("ok");
  });
  test("advances past a throwing update handler and does not process it again", async () => {
    const reports: string[] = [], delays: number[] = [];
    const f = await pairedFixture({ reportError: area => reports.push(area), sleep: async ms => { delays.push(ms); } });
    const listSessions = f.db.listSessions.bind(f.db);
    let calls = 0;
    f.db.listSessions = ((...args: Parameters<DashDB["listSessions"]>) => {
      calls++;
      if (calls === 1) throw new Error("synthetic list failure");
      return listSessions(...args);
    }) as DashDB["listSessions"];
    f.bot.enqueue(message("/status"));

    await eventually(() => f.db.getSetting("telegram.offset") === "2", "failed update offset");
    await eventually(() => f.bot.calls.some(call => call.method === "getUpdates" && call.body.offset === 2), "next poll offset");
    f.bot.enqueue(message("/help"));
    await eventually(() => f.db.getSetting("telegram.offset") === "3", "following update");

    expect(calls).toBe(1);
    const help = visibleText(f.bot.sent[0].text);
    expect(help).toContain("/status");
    expect(help).toContain("/mode");
    expect(reports).toEqual(["telegram update"]);
    expect(delays).toEqual([]);
    expect(f.telegram.health().state).toBe("ok");
  });
});

describe("Telegram pairing", () => {
  test("pairs a private message containing the valid code once", async () => {
    const f = fixture();
    await eventually(() => f.telegram.health().state === "unpaired");
    const code = f.telegram.info(true).pairingCode!;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    f.bot.enqueue(message(`/pair ${code.toLowerCase()}`));
    await eventually(() => f.telegram.health().paired);
    expect(f.db.getSetting("telegram.chat_id")).toBe(String(chat));
    expect(f.db.getSetting("telegram.user_id")).toBe(String(owner));
    expect(f.db.getSetting("telegram.username")).toBe("synthetic_owner");
    expect(f.telegram.info(true).pairingCode).toBeNull();
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent[0].text).toBe("Paired. You'll get alerts here.");
  });
  test("ignores a wrong code and group pairing silently", async () => {
    const f = fixture();
    await eventually(() => f.telegram.health().state === "unpaired");
    const code = f.telegram.info(true).pairingCode!;
    f.bot.enqueue(message("/pair WRONGCOD"));
    f.bot.enqueue(message(`/pair ${code}`, { chat: { id: chat, type: "group" } }));
    await eventually(() => f.db.getSetting("telegram.offset") === "3");
    expect(f.telegram.health().paired).toBe(false);
    expect(f.bot.sent).toHaveLength(0);
  });
  test("rejects an expired pairing code", async () => {
    const clock = { now: 1_000_000 };
    const f = fixture({ clock });
    await eventually(() => f.telegram.health().state === "unpaired");
    const code = f.telegram.info(true).pairingCode!;
    clock.now += 600_001;
    f.bot.enqueue(message(`/pair ${code}`));
    await eventually(() => f.db.getSetting("telegram.offset") === "2");
    expect(f.telegram.health().paired).toBe(false);
  });
  test("ignores a different user after pairing", async () => {
    const f = await pairedFixture();
    f.bot.enqueue(message("/help", { from: { id: owner + 1 } }));
    await eventually(() => f.db.getSetting("telegram.offset") === "2");
    expect(f.bot.sent).toHaveLength(0);
  });
  test("does not accept a reused pairing code", async () => {
    const f = fixture();
    await eventually(() => f.telegram.health().state === "unpaired");
    const code = f.telegram.info(true).pairingCode!;
    f.bot.enqueue(message(`/pair ${code}`));
    await eventually(() => f.telegram.health().paired);
    await apiSettled(() => f.bot.sent.length === 1);
    await eventually(() => f.db.getSetting("telegram.offset") === "2");
    f.bot.enqueue(message(`/pair ${code}`, { from: { id: owner + 1 }, chat: { id: chat + 1, type: "private" } }));
    await eventually(() => f.db.getSetting("telegram.offset") === "3");
    expect(f.bot.sent).toHaveLength(1);
    expect(f.db.getSetting("telegram.user_id")).toBe(String(owner));
  });
  test("unpair deletes the owner fields", async () => {
    const f = await pairedFixture();
    f.telegram.unpair();
    expect(f.db.getSetting("telegram.chat_id")).toBeUndefined();
    expect(f.db.getSetting("telegram.user_id")).toBeUndefined();
    expect(f.db.getSetting("telegram.username")).toBeUndefined();
  });
});

describe("Telegram alerts", () => {
  test("marks the original question answered when the console resumes", async () => {
    const f = await pairedFixture();
    const question = dto("needs_input");
    f.telegram.observe(question);
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    f.telegram.observe(dto("working"), "question_answered");
    await apiSettled(() => f.bot.count("editMessageText") === 1, "answered alert edit");
    const edit = f.bot.calls.find(call => call.method === "editMessageText")!.body;
    expect(edit).toMatchObject({ chat_id: String(chat), message_id: 1 });
    expect(edit.text).toContain("Answered");
    expect(edit.text).toContain("Can I use &lt;this&gt; &amp; that?");
    expect(f.bot.sent).toHaveLength(1);
  });
  test("retries exhausted alert edits without a restart or another session event", async () => {
    let sweep!: () => void;
    const reports: string[] = [];
    const f = await topicFixture({ setTimer: fn => { sweep = fn; return () => {}; },
      reportError: area => reports.push(area) });
    f.telegram.observe(dto("needs_input"));
    await eventually(() => !!f.db.alertFor(String(group), 1));
    f.bot.editSequence = Array.from({ length: 4 }, () => ({ status: 503, body: { ok: false, error_code: 503 } }));
    f.telegram.observe(dto("working"), "question_answered");
    await eventually(() => reports.includes("telegram send"));
    expect(f.bot.count("editMessageText")).toBe(4);
    sweep();
    await eventually(() => f.db.pendingAlertUpdates(f.clock.now).length === 0, "recovered alert edit");
    expect(f.bot.count("editMessageText")).toBe(5);
    expect(f.bot.calls.filter(call => call.method === "editMessageText").at(-1)!.body.text).toContain("Answered");
    expect(f.bot.sent).toHaveLength(1);
  });
  test("restores valid pending alerts while discarding malformed saved content", async () => {
    const f = await pairedFixture();
    const row = f.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "valid-restore",
      kind: "question", text: "Keep this question", ts: f.clock.now, interactive: true });
    f.telegram.observe(row);
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    for (const [index, content] of ["{", '{"alerts":[]}', '{"alerts":[{"dto":null}],"text":"invalid"}'].entries()) {
      f.db.rememberAlert(String(chat), 10 + index, null, "digest", f.clock.now);
      f.db.setAlertContent(String(chat), 10 + index, content);
    }
    f.telegram.close();
    f.db.applyEvent({ host: row.host, harness: row.harness, sessionId: row.sessionId,
      kind: "question_answered", ts: ++f.clock.now, interactive: true });
    const reports: string[] = [];
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => f.clock.now,
      readToken: async () => token, sleep: async ms => { f.clock.now += ms; },
      reportError: area => reports.push(area) });
    resources.push(() => again.close());
    again.start();
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    await eventually(() => f.db.pendingAlertUpdates(f.clock.now).length === 0);
    expect(reports).toEqual(["telegram alert restore", "telegram alert restore", "telegram alert restore"]);
    const edit = f.bot.calls.find(call => call.method === "editMessageText")!.body;
    expect(edit.message_id).toBe(1);
    expect(edit.text).toContain("Answered");
    expect(edit.text).toContain("Keep this question");
  });
  test("does not update historical DM content after restarting in topic mode", async () => {
    const f = await pairedFixture();
    const row = f.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "dm-cutover",
      kind: "question", text: "Synthetic old question", ts: f.clock.now, interactive: true });
    f.telegram.observe(row);
    await apiSettled(() => !!f.db.alertFor(String(chat), 1));
    f.telegram.close();
    f.db.setSetting("telegram.topics", JSON.stringify({ groupChatId: String(group), topics: defaultTopics }));
    const resumed = f.db.applyEvent({ host: row.host, harness: row.harness, sessionId: row.sessionId,
      kind: "question_answered", ts: ++f.clock.now, interactive: true });
    const again = createTelegram({ db: f.db, topicsEnabled: true, apiBase: f.bot.base, fetch: trackedFetch,
      now: () => f.clock.now, readToken: async () => token, sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok");
    again.observe(resumed, "question_answered");
    expect(await again.sendUrgent("synthetic", "Group synchronization marker")).toBe(true);
    expect(f.bot.calls.filter(call => call.method === "editMessageText")).toEqual([]);
    expect(f.bot.sent.slice(1).map(send => send.chat_id)).toEqual([String(group)]);
  });
  test("updates digest entries independently without answering a later question", async () => {
    const f = await pairedFixture();
    const rows = ["one", "two", "three"].map(name => dto("needs_input", {
      key: `synthetic-host|claude|${name}`, displayName: name,
    }));
    for (const row of rows) f.telegram.observe(row);
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    f.telegram.observe({ ...rows[0], status: "working" }, "question_answered");
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    const first = f.bot.calls.filter(call => call.method === "editMessageText")[0].body;
    const firstText = visibleText(first.text);
    expect(firstText).toMatch(/\b2 need you\b/);
    expect(firstText).toMatch(/one[\s\S]*Answered/);
    expect(firstText).toMatch(/two[\s\S]*Question/);
    f.telegram.observe({ ...rows[0], needsText: "A new question" }, "question");
    await eventually(() => !!f.db.alertFor(String(chat), 2));
    for (const row of rows.slice(1)) f.telegram.observe({ ...row, status: "working" }, "question_answered");
    await eventually(() => f.bot.calls.some(call => call.method === "editMessageText" && /\b3 resolved\b/.test(visibleText(call.body.text))));
    expect(f.bot.calls.filter(call => call.method === "editMessageText").every(call => call.body.message_id === 1)).toBe(true);
    expect(f.bot.sent[1].text).toContain("A new question");
  });
  test("handles a console answer while an alert is waiting to send", async () => {
    let release!: () => void;
    const f = await pairedFixture({ sleep: () => new Promise<void>(resolve => { release = resolve; }) });
    f.bot.enqueue(message("/help"));
    await apiSettled(() => f.bot.sent.length === 1);
    f.telegram.observe(dto("needs_input"));
    await eventually(() => !!release);
    f.telegram.observe(dto("working"), "question_answered");
    release();
    await eventually(() => !!f.db.alertFor(String(chat), 2));
    release();
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    expect(f.bot.calls.find(call => call.method === "editMessageText")!.body).toMatchObject({ message_id: 2 });
    expect(f.bot.calls.find(call => call.method === "editMessageText")!.body.text).toContain("Answered");
  });
  test("restores alert updates after restart and edits the actual delivery chat", async () => {
    const f = await topicFixture();
    const row = seedTopicQuestion(f.db, "answered-restart", "invest", f.clock.now);
    f.bot.nextSend = { status: 400, body: { ok: false, error_code: 400 } };
    f.telegram.observe(row);
    await eventually(() => !!f.db.alertFor(String(group), 2));
    f.telegram.close();
    const answered = f.db.applyEvent({ host: row.host, harness: row.harness, sessionId: row.sessionId,
      kind: "question_answered", ts: ++f.clock.now, interactive: true });
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => f.clock.now,
      topicsEnabled: true, readToken: async () => token, sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    const edit = f.bot.calls.find(call => call.method === "editMessageText")!.body;
    expect(edit).toMatchObject({ chat_id: String(group), message_id: 2 });
    expect(edit.text).toContain("Answered");
    await eventually(() => f.db.pendingAlertUpdates(f.clock.now).length === 0);
    again.observe(answered);
    expect(f.bot.sent).toHaveLength(2);
  });
  test("does not label errors or ended sessions as answered", async () => {
    const f = await pairedFixture();
    const row = dto("needs_input");
    f.telegram.observe(row);
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    f.telegram.observe({ ...row, status: "your_turn", lastError: "Failed" }, "error");
    f.telegram.observe({ ...row, status: "ended" }, "session_end");
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    const edit = f.bot.calls.find(call => call.method === "editMessageText")!.body;
    expect(edit.text).toContain("Session ended");
    expect(edit.text).not.toContain("Answered");
  });
  test("marks turn-finished alerts answered when a new console prompt starts", async () => {
    const f = await pairedFixture({ mode: "turns" });
    f.telegram.observe(dto("working"));
    f.telegram.observe(dto("your_turn"));
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    f.telegram.observe(dto("working"), "prompt");
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    expect(f.bot.calls.find(call => call.method === "editMessageText")!.body.text).toContain("Answered");
  });
  test("does not mistake background liveness for an answer to a turn alert", async () => {
    const f = await pairedFixture({ mode: "turns", clock: { now: Date.now() } });
    const event = { host: "synthetic-host", harness: "claude" as const, sessionId: "background-turn", interactive: true };
    f.telegram.observe(f.db.applyEvent({ ...event, kind: "prompt", ts: f.clock.now, text: "Do the work" }), "prompt");
    f.telegram.observe(f.db.applyEvent({ ...event, kind: "response", ts: ++f.clock.now, text: "Done", backgroundTasks: 1 }), "response");
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    f.clock.now += 21_000;
    const [busy] = f.db.markLiveness("claude", [{ sessionId: event.sessionId, detail: "busy" }], event.host, f.clock.now);
    expect(busy!.status).toBe("working");
    f.telegram.observe(busy!);
    f.bot.enqueue(message("/help"));
    await eventually(() => f.db.getSetting("telegram.offset") === "2");
    expect(f.bot.count("editMessageText")).toBe(0);
    f.telegram.observe(f.db.applyEvent({ ...event, kind: "prompt", ts: ++f.clock.now, text: "Next task" }), "prompt");
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    expect(f.bot.calls.find(call => call.method === "editMessageText")!.body.text).toContain("Answered");
  });
  test("requeues digest resolutions arriving during an edit without waiting for maintenance", async () => {
    const f = await pairedFixture({ setTimer: () => () => {} });
    const rows = ["one", "two", "three"].map(name => dto("needs_input", { key: `synthetic-host|claude|${name}`, displayName: name }));
    for (const row of rows) f.telegram.observe(row);
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    let release!: () => void;
    f.bot.beforeEdit = () => new Promise<void>(resolve => { release = resolve; });
    f.telegram.observe({ ...rows[0], status: "working" }, "question_answered");
    await eventually(() => !!release);
    f.telegram.observe({ ...rows[1], status: "working" }, "question_answered");
    f.bot.beforeEdit = undefined;
    release();
    await apiSettled(() => f.bot.count("editMessageText") === 2, "latest digest edit");
    expect(visibleText(f.bot.calls.filter(call => call.method === "editMessageText").at(-1)!.body.text)).toMatch(/\b1 need you\b/);
  });
  test.each([400, 403])("retires permanently uneditable alerts after HTTP %i", async status => {
    let sweep!: () => void;
    const f = await pairedFixture({ setTimer: fn => { sweep = fn; return () => {}; } });
    f.telegram.observe(dto("needs_input"));
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    f.bot.editSequence = Array.from({ length: 4 }, () => ({ status, body: { ok: false, error_code: status, description: "message cannot be edited" } }));
    f.telegram.observe(dto("working"), "question_answered");
    await eventually(() => f.db.pendingAlertUpdates(f.clock.now).length === 0, "retired alert update");
    sweep();
    f.bot.enqueue(message("/help"));
    await eventually(() => f.db.getSetting("telegram.offset") === "2");
    expect(f.bot.count("editMessageText")).toBe(1);
    expect(f.bot.sent).toHaveLength(2);
  });
  test("keeps digest tracking when Telegram reports an unchanged edit", async () => {
    const f = await pairedFixture();
    const rows = ["one", "two", "three"].map(name => dto("needs_input", { key: `synthetic-host|claude|${name}`, displayName: name }));
    for (const row of rows) f.telegram.observe(row);
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    f.bot.editSequence = [{ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message is not modified" } }];
    f.telegram.observe({ ...rows[0], status: "working" }, "question_answered");
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    f.telegram.observe({ ...rows[1], status: "working" }, "question_answered");
    await apiSettled(() => f.bot.count("editMessageText") === 2);
    expect(visibleText(f.bot.calls.filter(call => call.method === "editMessageText").at(-1)!.body.text)).toMatch(/\b2 resolved\b/);
  });
  test.each([false, true])("restores turn alerts using prompt evidence, not working status (answered=%s)", async answered => {
    const f = await pairedFixture({ mode: "turns", clock: { now: Date.now() } });
    const event = { host: "synthetic-host", harness: "claude" as const, sessionId: "restart-turn", interactive: true };
    f.telegram.observe(f.db.applyEvent({ ...event, kind: "prompt", ts: f.clock.now, text: "First prompt" }), "prompt");
    f.telegram.observe(f.db.applyEvent({ ...event, kind: "response", ts: ++f.clock.now, text: "Done", backgroundTasks: 1 }), "response");
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    f.telegram.close();
    f.clock.now += 21_000;
    f.db.markLiveness("claude", [{ sessionId: event.sessionId, detail: "busy" }], event.host, f.clock.now);
    if (answered) f.db.applyEvent({ ...event, kind: "prompt", ts: ++f.clock.now, text: "Next prompt" });
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => f.clock.now,
      readToken: async () => token, sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok");
    f.bot.enqueue(message("/help"));
    await eventually(() => f.db.getSetting("telegram.offset") === "2");
    expect(f.bot.count("editMessageText")).toBe(answered ? 1 : 0);
    if (answered) expect(f.bot.calls.find(call => call.method === "editMessageText")!.body.text).toContain("Answered");
  });
  test("sends escaped question HTML with a session mute keyboard", async () => {
    const f = await pairedFixture();
    f.telegram.observe(dto("needs_input"));
    await apiSettled(() => f.bot.sent.length === 1);
    const visible = visibleText(f.bot.sent[0].text);
    expect(visible).toContain("Project <one>");
    expect(visible).toContain("Can I use <this> & that?");
    expect(f.bot.sent[0].text).toContain("Project &lt;one&gt;");
    expect(f.bot.sent[0].text).toContain("Can I use &lt;this&gt; &amp; that?");
    expect(f.bot.sent[0].parse_mode).toBe("HTML");
    expect(f.bot.sent[0].reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^ms:[a-f0-9]{12}$/);
  });
  test("does not alert twice during the same needs-input episode", async () => {
    const f = await pairedFixture();
    f.telegram.observe(dto("needs_input"));
    await apiSettled(() => f.bot.sent.length === 1);
    f.telegram.observe(dto("needs_input", { needsText: "changed text" }));
    expect(f.bot.sent).toHaveLength(1);
  });
  test("alerts when the needs-input reason changes", async () => {
    const f = await pairedFixture();
    f.telegram.observe(dto("needs_input"));
    await apiSettled(() => f.bot.sent.length === 1);
    f.telegram.observe(dto("needs_input", { needsReason: "permission_prompt", needsText: "Approve?" }));
    await apiSettled(() => f.bot.sent.length === 2);
    expect(f.bot.sent[1].text).toContain("Permission needed");
  });
  test("alerts again after a prompt clears the prior question", async () => {
    const f = await pairedFixture();
    f.telegram.observe(dto("needs_input"));
    await apiSettled(() => f.bot.sent.length === 1);
    f.telegram.observe(dto("working"));
    f.telegram.observe(dto("needs_input", { needsText: "Another question" }));
    await apiSettled(() => f.bot.sent.length === 2);
  });
  test("does not alert for a non-interactive session", async () => {
    const f = await pairedFixture();
    f.telegram.observe(dto("needs_input", { interactive: false }));
    expect(f.bot.sent).toHaveLength(0);
    expect(f.telegram.health().queued).toBe(0);
  });
  test("suppresses alerts during a global mute", async () => {
    const f = await pairedFixture();
    f.db.setSetting("telegram.mute_until", String(f.clock.now + 3_600_000));
    f.telegram.observe(dto("needs_input"));
    expect(f.bot.sent).toHaveLength(0);
    expect(f.telegram.health().queued).toBe(0);
  });
  test("turns mode alerts on working to your_turn", async () => {
    const f = await pairedFixture({ mode: "turns" });
    f.telegram.observe(dto("working"));
    f.telegram.observe(dto("your_turn", { lastResponses: [{ id: 1, sessionKey: "synthetic-host|claude|session-1", ts: 1, text: "Synthetic answer", seen: false, source: "hook" }] }));
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent[0].text).toContain("✅");
    expect(f.bot.sent[0].text).toContain("Synthetic answer");
  });
  test("input mode does not alert on working to your_turn", async () => {
    const f = await pairedFixture();
    f.telegram.observe(dto("working"));
    f.telegram.observe(dto("your_turn"));
    expect(f.bot.sent).toHaveLength(0);
  });
  test("does not resend a question already persisted before startup", async () => {
    const f = await pairedFixture({ seededQuestion: true });
    f.telegram.observe(f.db.getSession("synthetic-host|claude|session-1")!);
    expect(f.bot.sent).toHaveLength(0);
  });
  test("off mode suppresses alerts", async () => {
    const f = await pairedFixture({ mode: "off" });
    f.telegram.observe(dto("needs_input"));
    expect(f.bot.sent).toHaveLength(0);
    expect(f.telegram.health().queued).toBe(0);
  });
  test("coalesces four simultaneous question alerts into one digest", async () => {
    const f = await pairedFixture();
    for (let i = 0; i < 4; i++) f.telegram.observe(dto("needs_input", { key: `synthetic-host|claude|session-${i}`, displayName: `Session ${i}` }));
    await apiSettled(() => f.bot.sent.length === 1);
    expect(visibleText(f.bot.sent[0].text)).toMatch(/4 sessions need you/);
    expect(f.bot.sent[0].reply_markup).toBeUndefined();
  });
  test("keeps every oversized digest row on its page and edits only the matching page", async () => {
    const f = await pairedFixture();
    const names = Array.from({ length: 12 }, (_, index) => `DigestSession-${String(index).padStart(2, "0")}`);
    const rows = names.map(name => dto("needs_input", {
      key: `synthetic-host|claude|${name}`, displayName: name,
    }));
    for (const row of rows) f.telegram.observe(row);
    await apiSettled(() => sendCalls(f.bot).length === 2, "all oversized digest pages");

    const pages = sendCalls(f.bot).map(call => visibleText(call.body.text));
    const membership = pages.map(page => names.filter(name => page.includes(name)));
    expect(pages.map((page, index) => page.includes(`Part ${index + 1}/2`))).toEqual([true, true]);
    expect(pages.every(page => page.length <= 4096)).toBe(true);
    expect(membership.flat().sort()).toEqual([...names].sort());
    expect(membership.every(page => page.length > 0 && page.length <= 10)).toBe(true);
    expect(f.db.alertFor(String(chat), 1)).toMatchObject({ sessionKey: null, kind: "digest" });
    expect(f.db.alertFor(String(chat), 2)).toMatchObject({ sessionKey: null, kind: "digest" });

    const pageTwoRow = rows.find(row => row.displayName === membership[1][0])!;
    f.telegram.observe({ ...pageTwoRow, status: "working" }, "question_answered");
    await apiSettled(() => f.bot.count("editMessageText") === 1, "page-two digest edit");
    const edits = f.bot.calls.filter(call => call.method === "editMessageText").map(call => call.body);
    expect(edits).toHaveLength(1);
    expect(edits[0].message_id).toBe(2);
    const editedPage = visibleText(edits[0].text);
    expect(editedPage).toMatch(/\b1 need you\b/);
    expect(editedPage).toMatch(/\b1 resolved\b/);
    expect(membership[1].every(name => editedPage.includes(name))).toBe(true);
    expect(membership[0].every(name => !editedPage.includes(name))).toBe(true);
  });
  test.each([25, 250])("release review: keeps a restored %i-row legacy digest editable within the API limit", async count => {
    const f = await pairedFixture();
    const rows = Array.from({ length: count }, (_, index) => dto("needs_input", {
      key: `legacy-${index}`, displayName: `Row${index} ${"n".repeat(65)}`, host: "h".repeat(70),
    }));
    f.db.rememberAlert(String(chat), 90, null, "digest", f.clock.now);
    f.db.setAlertContent(String(chat), 90, JSON.stringify({ text: "Legacy digest", alerts: rows.map(row => ({
      dto: row, reason: "question", turn: false, promptId: 0,
      destination: { chatId: String(chat), threadId: null, name: null },
    })) }));
    f.telegram.close();
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => f.clock.now,
      readToken: async () => token, sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok");
    again.observe({ ...rows[0], status: "working" }, "question_answered");
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    const first = f.bot.calls.find(call => call.method === "editMessageText")!.body;
    const text = visibleText(first.text);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain(`${count - 1} need you`);
    expect(text).toContain("1 resolved");
    if (count === 25) for (let index = 0; index < count; index++) expect(text).toContain(`Row${index} `);
    else expect(text).toMatch(/Showing \d+ of 250/);
    again.observe({ ...rows[1], status: "working" }, "question_answered");
    await apiSettled(() => f.bot.count("editMessageText") === 2);
    expect(f.db.pendingAlertUpdates(f.clock.now)).toHaveLength(1);
    expect(f.bot.sent).toHaveLength(0);
  });
  test("counts needs and finished turns separately in a turns-mode digest", async () => {
    const f = await pairedFixture({ mode: "turns" });
    for (let i = 0; i < 2; i++) f.telegram.observe(dto("needs_input", { key: `synthetic-host|claude|need-${i}`, displayName: `Need ${i}` }));
    for (let i = 0; i < 2; i++) {
      const key = `synthetic-host|claude|turn-${i}`;
      f.telegram.observe(dto("working", { key, displayName: `Turn ${i}` }));
      f.telegram.observe(dto("your_turn", { key, displayName: `Turn ${i}` }));
    }
    await apiSettled(() => f.bot.sent.length === 1);
    const summary = visibleText(f.bot.sent[0].text);
    expect(summary).toMatch(/\b2 need you\b/);
    expect(summary).toMatch(/\b2 finished\b/);
    expect(summary.match(/Question/g)).toHaveLength(2);
    expect(summary).toContain("Turn 0");
    expect(summary).toContain("Turn 1");
  });
  test("redacts before applying an explicit word-safe excerpt cap", async () => {
    const f = await pairedFixture({ snippetChars: 23 });
    const secret = `sk-${"A".repeat(30)}`;
    f.telegram.observe(dto("needs_input", { needsText: `${secret} alpha beta 🧪gamma delta epsilon FINAL-TAIL` }));
    await apiSettled(() => f.bot.sent.length === 1);
    const rendered = visibleText(f.bot.sent.map(send => send.text).join("\n"));
    expect(rendered).toContain("[redacted]");
    expect(rendered).toContain("alpha beta");
    expect(rendered).not.toContain("gamma");
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("FINAL-TAIL");
    expect(rendered).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(rendered).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(rendered).toMatch(/(?:…|\bexcerpt\b|\btruncated\b)/i);
  });
  test("release review: a malformed configured privacy cap never discloses the full response", async () => {
    const previous = process.env.DASH_TELEGRAM_SNIPPET_CHARS;
    try {
      process.env.DASH_TELEGRAM_SNIPPET_CHARS = "400chars";
      const f = await pairedFixture();
      f.telegram.observe(dto("needs_input", { needsText: `${"Visible words. ".repeat(60)}PRIVATE_TAIL` }));
      await apiSettled(() => f.bot.sent.length === 1);
      const text = visibleText(f.bot.sent[0].text);
      expect(text).not.toContain("PRIVATE_TAIL");
      expect(text).toMatch(/excerpt/i);
    } finally {
      if (previous === undefined) delete process.env.DASH_TELEGRAM_SNIPPET_CHARS;
      else process.env.DASH_TELEGRAM_SNIPPET_CHARS = previous;
    }
  });
  test("omits captured text when the configured limit is zero", async () => {
    const f = await pairedFixture({ snippetChars: 0 });
    f.telegram.observe(dto("needs_input", { needsText: "Synthetic private text" }));
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent.map(send => visibleText(send.text)).join("\n")).not.toContain("Synthetic private text");
  });
  test("delivers, registers, and edits every part of a complete long alert after restart", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    const longText = `${"🧪".repeat(3_500)} FINAL-TAIL-OF-CAPTURE`;
    const row = f.db.applyEvent({ host: "synthetic-host", harness: "omp", sessionId: "long-captured",
      kind: "question", ts: f.clock.now, text: longText, interactive: true });
    f.telegram.observe(row);
    await apiSettled(() => sendCalls(f.bot).length === 3, "all alert parts");
    const alertParts = sendCalls(f.bot);
    const visibleParts = alertParts.map(call => visibleText(call.body.text));
    expect(alertParts.every(call => call.body.parse_mode === "HTML")).toBe(true);
    expect(visibleParts.every(text => text.length <= 4096)).toBe(true);
    expect(visibleParts.map((text, index) => text.includes(`Part ${index + 1}/${alertParts.length}`))).toEqual([true, true, true]);
    expect(visibleParts.join("\n")).toContain("FINAL-TAIL-OF-CAPTURE");
    expect(visibleParts.map(text => text.match(/🧪/gu)?.length ?? 0).reduce((total, count) => total + count, 0)).toBe(3_500);
    for (let index = 0; index < alertParts.length; index++) {
      expect(f.db.alertFor(String(chat), index + 1)).toEqual({ sessionKey: row.key, kind: "alert" });
    }

    f.bot.enqueue(message("Owner answer", { reply_to_message: { message_id: 2 } }));
    await eventually(() => f.db.queuedReplies().length === 1, "reply to a later alert part");
    expect(f.db.queuedReplies()[0].sessionKey).toBe(row.key);

    f.telegram.close();
    f.db.applyEvent({ host: row.host, harness: row.harness, sessionId: row.sessionId,
      kind: "question_answered", ts: ++f.clock.now, interactive: true });
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => f.clock.now, replies: f.replies,
      readToken: async () => token, sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await apiSettled(() => f.bot.count("editMessageText") === alertParts.length, "all alert-part edits after restart");
    await eventually(() => f.db.pendingAlertUpdates(f.clock.now).length === 0);
    const edits = f.bot.calls.filter(call => call.method === "editMessageText").map(call => call.body);
    expect(edits.map(edit => edit.message_id).sort((left, right) => left - right)).toEqual([1, 2, 3]);
    const editedParts = edits.map(edit => visibleText(edit.text));
    expect(editedParts.every(text => text.includes("Answered") && text.length <= 4096)).toBe(true);
    expect(editedParts.join("\n")).toContain("FINAL-TAIL-OF-CAPTURE");
    expect(editedParts.map(text => text.match(/🧪/gu)?.length ?? 0).reduce((total, count) => total + count, 0)).toBe(3_500);
  });
  test("retries a 429 send after the server retry_after delay", async () => {
    const delays: number[] = [];
    const f = await pairedFixture({ sleep: async ms => { delays.push(ms); } });
    f.bot.nextSend = { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 3 } } };
    f.telegram.observe(dto("needs_input"));
    await apiSettled(() => f.bot.sent.length === 2);
    expect(delays).toContain(3_000);
    await eventually(() => f.telegram.health().sent === 1);
    expect(f.telegram.health().sent).toBe(1);
  });
  test("release review: a failed session does not discard its queued sibling", async () => {
    const f = await pairedFixture();
    f.bot.sendSequence = Array.from({ length: 4 }, () => ({ status: 503, body: { ok: false, error_code: 503 } }));
    f.telegram.observe(dto("needs_input", { key: "failed-session", needsText: "First session question" }));
    f.telegram.observe(dto("needs_input", { key: "sibling-session", needsText: "Sibling session question" }));
    await eventually(() => f.telegram.health().dropped === 1);
    f.bot.enqueue(message("/help"));
    await eventually(() => f.db.getSetting("telegram.offset") === "2");
    expect(f.bot.sent.filter(send => send.text.includes("First session question"))).toHaveLength(4);
    expect(f.bot.sent.filter(send => send.text.includes("Sibling session question"))).toHaveLength(1);
    expect(f.db.alertFor(String(chat), 5)?.sessionKey).toBe("sibling-session");
  });
  test("spaces consecutive sends by at least one second", async () => {
    const delays: number[] = [];
    const clock = { now: 1_000_000 };
    const f = await pairedFixture({ clock, sleep: async ms => { delays.push(ms); clock.now += ms; } });
    f.telegram.observe(dto("needs_input"));
    await apiSettled(() => f.bot.sent.length === 1);
    f.telegram.observe(dto("working"));
    f.telegram.observe(dto("needs_input", { needsText: "Second question" }));
    await apiSettled(() => f.bot.sent.length === 2);
    expect(delays).toContain(1_000);
  });
  test("shares the one-second send slot between an alert and a command reply", async () => {
    const clock = { now: 1_000_000 };
    const waits: Array<{ ms: number; release: () => void }> = [];
    const f = await pairedFixture({ clock, sleep: ms => new Promise<void>(resolve => waits.push({ ms, release: resolve })) });
    f.telegram.observe(dto("needs_input"));
    f.bot.enqueue(message("/help"));
    await apiSettled(() => f.bot.sent.length === 1, "first send");
    await eventually(() => waits.length === 1, "shared send slot");
    expect(f.bot.sent).toHaveLength(1);
    expect(waits[0].ms).toBe(1_000);
    clock.now += waits[0].ms;
    waits[0].release();
    await apiSettled(() => f.bot.sent.length === 2, "command reply");
    expect(f.bot.sendTimes[1] - f.bot.sendTimes[0]).toBeGreaterThanOrEqual(1_000);
  });
  test("does not deliver a retrying old alert to a new owner after unpair and re-pair", async () => {
    const clock = { now: 1_000_000 };
    const waits: Array<{ ms: number; release: () => void }> = [];
    const f = await pairedFixture({ clock, sleep: ms => new Promise<void>(resolve => waits.push({ ms, release: resolve })) });
    f.bot.nextSend = { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 3 } } };
    f.telegram.observe(dto("needs_input"));
    await eventually(() => waits.some(wait => wait.ms === 3_000), "retry delay");
    expect(f.bot.sent).toHaveLength(1);
    expect(f.bot.sent[0].chat_id).toBe(String(chat));

    f.telegram.unpair();
    const code = f.telegram.info(true).pairingCode!;
    const nextChat = chat + 1, nextOwner = owner + 1;
    f.bot.enqueue(message(`/pair ${code}`, {
      from: { id: nextOwner, username: "next_owner" }, chat: { id: nextChat, type: "private" },
    }));
    await eventually(() => f.db.getSetting("telegram.user_id") === String(nextOwner), "new owner pairing");
    clock.now += 3_000;
    for (const wait of waits.splice(0)) wait.release();
    await eventually(() => f.bot.sent.some(send => send.chat_id === String(nextChat)), "new owner confirmation");
    expect(f.bot.sent.filter(send => send.chat_id === String(nextChat)).map(send => send.text))
      .toEqual(["Paired. You'll get alerts here."]);
    expect(f.bot.sent).toHaveLength(2);
  });
});

describe("Telegram redaction", () => {
  const patterns = [
    ["OpenAI key", `sk-${"A".repeat(16)}`],
    ["xAI key", `xai-${"A".repeat(16)}`],
    ["GitHub classic token", `ghp_${"A".repeat(20)}`],
    ["GitHub fine-grained token", `github_pat_${"A".repeat(20)}`],
    ["AWS access key", `AKIA${"A".repeat(16)}`],
    ["Google API key", `AIza${"A".repeat(35)}`],
    ["Telegram token", token],
    ["JWT", `eyJ${"A".repeat(12)}.${"B".repeat(12)}.${"C".repeat(12)}`],
    // Marker split so secret scanners never see a contiguous PEM header in source; runtime value is unchanged.
    ["private key", "-----BEGIN PRIVATE " + "KEY-----\nSYNTHETICDATA\n-----END PRIVATE " + "KEY-----"],
    ["high-entropy run", "A1".repeat(20)],
  ];
  test.each(patterns)("redacts a %s", (_, secret) => {
    expect(redact(`before ${secret} after`)).toBe("before [redacted] after");
  });
  test("preserves normal prose", () => {
    expect(redact("Please review the build tomorrow at noon.")).toBe("Please review the build tomorrow at noon.");
  });
});

describe("Telegram topic delivery", () => {
  const failed = (status: number) => ({ status, body: { ok: false, error_code: status, description: "synthetic failure text" } });

  test("sends a project alert to its bound topic", async () => {
    const f = await topicFixture();
    f.telegram.observe(dto("needs_input", { project: "invest" }));
    await apiSettled(() => sendCalls(f.bot).length === 1, "invest alert");

    const call = sendCalls(f.bot)[0];
    expect(call.method).toBe("sendMessage");
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 42, parse_mode: "HTML" });
    expect(visibleText(call.body.text)).toContain("Project <one>");
    expect(call.body.text).toContain("Project &lt;one&gt;");
  });

  test("omits the thread ID when sending to General", async () => {
    const f = await topicFixture();
    f.telegram.observe(dto("needs_input", { project: "unbound" }));
    await apiSettled(() => sendCalls(f.bot).length === 1, "General alert");

    const call = sendCalls(f.bot)[0];
    expect(call.method).toBe("sendMessage");
    expect(call.body.chat_id).toBe(String(group));
    expect(call.body).not.toHaveProperty("message_thread_id");
  });

  test.each([false, true])("withholds unmatched alerts and urgent bodies without General (group bound: %s)", async bound => {
    const f = await pairedFixture({ topicsEnabled: true,
      bindings: bound ? { groupChatId: String(group), topics: { invest: 42 } } : undefined });
    f.telegram.observe(dto("needs_input", { project: "unbound" }));
    expect(await f.telegram.sendUrgent("unbound", "Synthetic urgent body")).toBe(false);
    expect(sendCalls(f.bot)).toEqual([]);
  });

  test("forms one project digest and preserves the first destination order", async () => {
    const f = await topicFixture();
    const alert = (name: string, project: string) => dto("needs_input", {
      key: `synthetic-host|claude|${name}`, displayName: name, project,
    });
    f.telegram.observe(alert("Defense one", "defense"));
    f.telegram.observe(alert("Invest one", "invest"));
    f.telegram.observe(alert("Defense two", "defense"));
    f.telegram.observe(alert("Invest two", "invest"));
    f.telegram.observe(alert("Invest three", "invest"));
    await apiSettled(() => sendCalls(f.bot).length === 3, "topic alert buckets");

    const calls = sendCalls(f.bot);
    expect(calls.map(call => call.method)).toEqual(["sendMessage", "sendMessage", "sendMessage"]);
    expect(calls[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 56 });
    expect(visibleText(calls[0].body.text)).toContain("Defense one");
    expect(calls[1].body).toMatchObject({ chat_id: String(group), message_thread_id: 56 });
    expect(visibleText(calls[1].body.text)).toContain("Defense two");
    expect(calls[2].body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
    expect(visibleText(calls[2].body.text)).toMatch(/3 sessions need you/);
    expect(visibleText(calls[2].body.text)).toContain("Invest three");
  });

  test("preserves a historical DM alert with the same numeric ID as a new group alert", async () => {
    const f = await topicFixture();
    f.bot.sendSequence = [{ status: 200, body: ok({ message_id: 7 }) }];
    const invest = dto("needs_input", { key: "synthetic-host|claude|invest-alert", project: "invest" });
    const dm = dto("needs_input", { key: "synthetic-host|claude|dm-alert", project: "unbound" });
    f.db.rememberAlert(String(chat), 7, dm.key, "alert", f.clock.now);
    f.telegram.observe(invest);
    await apiSettled(() => f.db.alertFor(String(group), 7)?.sessionKey === invest.key, "group alert");

    expect(sendCalls(f.bot).map(call => call.body.chat_id)).toEqual([String(group)]);
    expect(f.db.alertFor(String(group), 7)?.sessionKey).toBe(invest.key);
    expect(f.db.alertFor(String(chat), 7)?.sessionKey).toBe(dm.key);
  });

  test("falls back from a topic 400 to one General send", async () => {
    const f = await topicFixture();
    f.bot.sendSequence = [failed(400)];
    f.telegram.observe(dto("needs_input", { project: "invest" }));
    await apiSettled(() => sendCalls(f.bot).length === 2, "General fallback");

    const calls = sendCalls(f.bot);
    expect(calls.map(call => call.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(calls[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
    expect(calls[1].body.chat_id).toBe(String(group));
    expect(calls[1].body).not.toHaveProperty("message_thread_id");
  });

  test("falls back from a topic 403 to General", async () => {
    const f = await topicFixture();
    f.bot.sendSequence = [failed(403)];
    f.telegram.observe(dto("needs_input", { project: "invest" }));
    await apiSettled(() => sendCalls(f.bot).length === 2, "403 General fallback");

    expect(sendCalls(f.bot).map(call => call.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(sendCalls(f.bot)[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
    expect(sendCalls(f.bot)[1].body.chat_id).toBe(String(group));
    expect(sendCalls(f.bot)[1].body).not.toHaveProperty("message_thread_id");
  });

  test("drops a reply confirmation when its topic and General reject it, without sending a DM", async () => {
    const f = await topicFixture({ repliesEnabled: true });
    const row = f.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "replyable", cwd: "/projects/invest/reply", kind: "question", ts: f.clock.now, text: "Synthetic question", interactive: true });
    f.db.sqlite.query("UPDATE sessions SET needs_reason='waiting' WHERE key=?").run(row.key);
    f.db.rememberAlert(String(group), 9, row.key, "alert", f.clock.now);
    f.bot.sendSequence = [failed(400), failed(400)];
    f.bot.enqueue(groupMessage("Answer", 42, { message_id: 55, reply_to_message: { message_id: 9 } }));
    await apiSettled(() => f.telegram.health().dropped === 1, "group-only reply failure");

    const calls = sendCalls(f.bot);
    expect(calls.map(call => call.body.chat_id)).toEqual([String(group), String(group)]);
    expect(calls[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 42,
      reply_parameters: { message_id: 55, allow_sending_without_reply: true } });
    expect(calls[1].body.chat_id).toBe(String(group));
    expect(calls[1].body).not.toHaveProperty("message_thread_id");
    expect(calls[1].body).not.toHaveProperty("reply_parameters");
    expect(f.db.queuedReplies().map(reply => reply.sessionKey)).toEqual([row.key]);
  });

  test("sends the complete urgent body to General in numbered Telegram-safe parts when no urgent binding exists", async () => {
    const f = await topicFixture({ bindings: { groupChatId: String(group), topics: { invest: 42, general: null } } });
    const body = `${"🧪".repeat(3_500)} FINAL-URGENT-TAIL`;
    expect(await f.telegram.sendUrgent("invest", body)).toBe(true);
    await apiSettled(() => sendCalls(f.bot).length === 3, "all urgent General parts");

    const calls = sendCalls(f.bot);
    const parts = calls.map(call => visibleText(call.body.text));
    expect(calls.every(call => call.body.chat_id === String(group) && call.body.parse_mode === "HTML"
      && !("message_thread_id" in call.body))).toBe(true);
    expect(parts.map((text, index) => text.includes(`Part ${index + 1}/3`))).toEqual([true, true, true]);
    expect(parts.every(text => text.length <= 4096)).toBe(true);
    expect(parts[0]).toMatch(/urgent/i);
    expect(parts[0]).toMatch(/project/i);
    expect(parts[0]).toContain("invest");
    expect(parts.join("\n")).toContain("FINAL-URGENT-TAIL");
    expect(parts.map(text => text.match(/🧪/gu)?.length ?? 0).reduce((total, count) => total + count, 0)).toBe(3_500);
  });

  test("falls back from a rejected urgent topic through General", async () => {
    const f = await topicFixture();
    f.bot.sendSequence = [failed(400)];
    expect(await f.telegram.sendUrgent("invest", "Synthetic urgent body")).toBe(true);
    await apiSettled(() => sendCalls(f.bot).length === 2, "urgent General fallback");

    const calls = sendCalls(f.bot);
    expect(calls.map(call => call.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(calls[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 90 });
    expect(calls[1].body).toMatchObject({ chat_id: String(group) });
    expect(calls[1].body).not.toHaveProperty("message_thread_id");
    expect(visibleText(calls[0].body.text)).toContain("Synthetic urgent body");
    expect(visibleText(calls[1].body.text)).toContain("Synthetic urgent body");
  });

  test("routes an error event to one escaped urgent message without a routine alert", async () => {
    const f = await topicFixture();
    f.telegram.observe(dto("your_turn", { project: "Invest <one>", displayName: "Session <one>" }), "error");
    await apiSettled(() => sendCalls(f.bot).length === 1, "urgent error message");

    const call = sendCalls(f.bot)[0];
    expect(call.method).toBe("sendMessage");
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 90 });
    expect(call.body.text).toContain("Invest &lt;one&gt;");
    expect(call.body.text).toContain("Session &lt;one&gt;");
    expect(visibleText(call.body.text)).toContain("Session error:");
    expect(visibleText(call.body.text)).not.toContain("Turn finished");
  });

  test("does not page from a stale liveness lastError", async () => {
    const f = await topicFixture();
    f.telegram.observe(dto("working", { lastError: "old synthetic error" }));

    expect(sendCalls(f.bot)).toHaveLength(0);
    expect(f.bot.calls.filter(call => call.method === "sendMessage")).toEqual([]);
  });

  test.each(["mute", "mode off", "normal"] as const)("sets urgent notification silence for %s", async condition => {
    const f = await topicFixture({ mode: condition === "mode off" ? "off" : undefined });
    if (condition === "mute") f.db.setSetting("telegram.mute_until", String(f.clock.now + 60_000));
    expect(await f.telegram.sendUrgent("invest", "Synthetic alert")).toBe(true);
    await apiSettled(() => sendCalls(f.bot).length === 1, "urgent message");

    const call = sendCalls(f.bot)[0];
    expect(call.method).toBe("sendMessage");
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 90 });
    if (condition === "normal") expect(call.body).not.toHaveProperty("disable_notification");
    else expect(call.body.disable_notification).toBe(true);
  });

  test("re-pages only after the strict threshold and preserves the mark across restart", async () => {
    const clock = { now: 1_000_000 };
    let sweep = () => {};
    let interval = 0;
    const f = await topicFixture({ clock, setTimer: (fn, ms) => { sweep = fn; interval = ms; return () => {}; } });
    const row = seedTopicQuestion(f.db, "urgent-sweep", "invest", clock.now);
    f.telegram.observe(row);
    await apiSettled(() => sendCalls(f.bot).length === 1, "initial routine alert");
    const startedAt = Number((f.db.sqlite.query("SELECT started_at FROM tg_urgent_episodes WHERE session_key=?").get(row.key) as { started_at: number }).started_at);
    expect(interval).toBe(60_000);

    clock.now = startedAt + 30 * 60_000;
    sweep();
    await Bun.sleep(5);
    expect(sendCalls(f.bot).filter(call => call.body.text.startsWith("⚠️ "))).toHaveLength(0);
    clock.now++;
    sweep();
    await apiSettled(() => sendCalls(f.bot).filter(call => call.body.text.startsWith("⚠️ ")).length === 1, "first overdue re-page");
    sweep();
    await Bun.sleep(5);
    expect(sendCalls(f.bot).filter(call => call.body.text.startsWith("⚠️ "))).toHaveLength(1);

    f.telegram.close();
    let restartedSweep = () => {};
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => clock.now, topicsEnabled: true,
      readToken: async () => token, sleep: async ms => { clock.now += ms; },
      setTimer: (fn, ms) => { restartedSweep = fn; return () => {}; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok", "restarted poller");
    restartedSweep();
    await Bun.sleep(5);
    expect(sendCalls(f.bot).filter(call => call.body.text.startsWith("⚠️ ")).length).toBe(1);
  });

  test("allows a fresh needs-input episode to re-page once", async () => {
    const clock = { now: 1_000_000 };
    let sweep = () => {};
    const f = await topicFixture({ clock, setTimer: fn => { sweep = fn; return () => {}; } });
    const row = seedTopicQuestion(f.db, "urgent-fresh", "invest", clock.now);
    f.telegram.observe(row);
    await apiSettled(() => sendCalls(f.bot).length === 1, "initial routine alert");
    clock.now = row.lastActivity + 30 * 60_000 + 1;
    sweep();
    await apiSettled(() => sendCalls(f.bot).filter(call => call.body.text.startsWith("⚠️ ")).length === 1, "first episode page");

    const ready = f.db.applyEvent({ host: row.host, harness: row.harness, sessionId: row.sessionId, kind: "response", ts: clock.now + 2, interactive: true });
    f.telegram.observe(ready);
    const fresh = f.db.applyEvent({ host: row.host, harness: row.harness, sessionId: row.sessionId, kind: "question", ts: clock.now + 3, text: "Fresh synthetic question", interactive: true });
    f.telegram.observe(fresh);
    await apiSettled(() => sendCalls(f.bot).filter(call => !call.body.text.startsWith("⚠️ ")).length === 2, "fresh routine alert");
    clock.now = fresh.lastActivity + 30 * 60_000;
    sweep();
    await Bun.sleep(5);
    expect(sendCalls(f.bot).filter(call => call.body.text.startsWith("⚠️ "))).toHaveLength(1);
    clock.now++;
    sweep();
    await apiSettled(() => sendCalls(f.bot).filter(call => call.body.text.startsWith("⚠️ ")).length === 2, "fresh episode re-page");
    sweep();
    await Bun.sleep(5);
    expect(sendCalls(f.bot).filter(call => call.body.text.startsWith("⚠️ "))).toHaveLength(2);
  });

  test("clears a confirmed missing OMP needs-input episode without a re-page", async () => {
    const clock = { now: 1_000_000 };
    let sweep = () => {};
    const f = await topicFixture({ clock, setTimer: fn => { sweep = fn; return () => {}; } });
    const row = f.db.applyEvent({ host: "synthetic-host", harness: "omp", sessionId: "missing-omp",
      cwd: "/projects/invest/omp", kind: "question", ts: clock.now, text: "Synthetic question", interactive: true });
    f.telegram.observe(row);
    await apiSettled(() => sendCalls(f.bot).length === 1, "initial OMP alert");
    f.db.sqlite.query("UPDATE sessions SET alive=0,dead_since=? WHERE key=?").run(clock.now, row.key);
    clock.now += 30 * 60_000 + 1;
    sweep();

    expect(f.db.hasUrgentEpisode(row.key)).toBe(false);
    expect(sendCalls(f.bot).filter(call => call.body.text.startsWith("⚠️ "))).toHaveLength(0);
  });

  test("still re-pages an OMP needs-input session with no confirmed missing timestamp", async () => {
    const clock = { now: 1_000_000 };
    let sweep = () => {};
    const f = await topicFixture({ clock, setTimer: fn => { sweep = fn; return () => {}; } });
    const row = f.db.applyEvent({ host: "synthetic-host", harness: "omp", sessionId: "hook-only-omp",
      cwd: "/projects/invest/omp", kind: "question", ts: clock.now, text: "Synthetic question", interactive: true });
    f.telegram.observe(row);
    await apiSettled(() => sendCalls(f.bot).length === 1, "initial OMP alert");
    f.db.sqlite.query("UPDATE sessions SET alive=0,dead_since=NULL WHERE key=?").run(row.key);
    clock.now += 30 * 60_000 + 1;
    sweep();
    await apiSettled(() => sendCalls(f.bot).filter(call => call.body.text.startsWith("⚠️ ")).length === 1, "hook-only OMP re-page");

    const call = sendCalls(f.bot).find(item => item.body.text.startsWith("⚠️ "))!;
    expect(call.method).toBe("sendMessage");
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 90 });
  });

  test.each([401, 404])("does not fall back after a topic send returns %i", async status => {
    const f = await topicFixture();
    f.bot.sendSequence = [failed(status)];
    f.telegram.observe(dto("needs_input", { project: "invest" }));
    await eventually(() => f.telegram.health().state === "bad_token", "bad token state");

    expect(sendCalls(f.bot)).toHaveLength(1);
    expect(sendCalls(f.bot)[0].method).toBe("sendMessage");
    expect(sendCalls(f.bot)[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
  });

  test.each([401, 404])("stops at General when a fallback send returns %i", async status => {
    const f = await topicFixture();
    f.bot.sendSequence = [failed(400), failed(status)];
    f.telegram.observe(dto("needs_input", { project: "invest" }));
    await eventually(() => f.telegram.health().state === "bad_token", "General bad token");

    const calls = sendCalls(f.bot);
    expect(calls.map(call => call.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(calls[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
    expect(calls[1].body.chat_id).toBe(String(group));
    expect(calls[1].body).not.toHaveProperty("message_thread_id");
  });

  test("drops a rejected General alert without retrying it or sending a DM", async () => {
    const f = await topicFixture();
    f.bot.sendSequence = [failed(400)];
    f.telegram.observe(dto("needs_input", { project: "unbound" }));
    await eventually(() => f.telegram.health().dropped === 1, "dropped General alert");

    expect(sendCalls(f.bot)).toHaveLength(1);
    expect(sendCalls(f.bot)[0].method).toBe("sendMessage");
    expect(sendCalls(f.bot)[0].body.chat_id).toBe(String(group));
    expect(sendCalls(f.bot)[0].body).not.toHaveProperty("message_thread_id");
  });

  test("reports a safe HTTP code without Bot API text or token", async () => {
    const reports: Array<{ area: string; name: string; code?: string; message: string }> = [];
    const f = await topicFixture({ reportError: (area, error) => {
      const safe = error as NodeJS.ErrnoException;
      reports.push({ area, name: error instanceof Error ? error.name : "", code: safe.code, message: error instanceof Error ? error.message : "" });
    } });
    f.bot.sendSequence = [failed(400)];
    f.telegram.observe(dto("needs_input", { project: "invest" }));
    await apiSettled(() => sendCalls(f.bot).length === 2, "reported fallback");

    expect(sendCalls(f.bot).map(call => call.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(reports).toEqual([{ area: "telegram send", name: "TelegramApiError", code: "TG_HTTP_400", message: "" }]);
    expect(JSON.stringify(reports)).not.toContain("synthetic failure text");
    expect(JSON.stringify(reports)).not.toContain(token);
  });
});

describe("Telegram DM command and retry behavior", () => {
  test.each(["/status", "/mode", "reply", "/unknown", "plain text"] as const)("preserves DM behavior for %s", async input => {
    const f = await pairedFixture();
    const update = input === "reply"
      ? message("answer", { reply_to_message: { message_id: 1 } })
      : message(input);
    f.bot.enqueue(update);
    await apiSettled(() => sendCalls(f.bot).length === 1, `DM response for ${input}`);

    const call = sendCalls(f.bot)[0];
    expect(call.body).toMatchObject({ chat_id: String(chat), parse_mode: "HTML", disable_web_page_preview: true });
    const response = visibleText(call.body.text);
    if (input === "/status") {
      expect(response).toMatch(/\b0\b/);
      expect(response).toMatch(/\b(?:need you|needs? input|waiting)\b/i);
      expect(response).toMatch(/\b(?:your turn|working)\b/i);
    } else if (input === "/mode") expect(response).toContain("Mode: input");
    else if (input === "reply") expect(response).toBe("Replies are off on the hub.");
    else {
      expect(response).toMatch(/reply to an alert/i);
      expect(response).toContain("/status");
      expect(response).toContain("/r N");
    }
  });

  test.each([400, 403])("retries a failed DM alert four times for HTTP %i", async status => {
    const f = await pairedFixture();
    f.bot.sendSequence = Array.from({ length: 4 }, () => ({ status, body: { ok: false, error_code: status, description: "synthetic failure text" } }));
    f.telegram.observe(dto("needs_input"));
    await apiSettled(() => sendCalls(f.bot).length === 4, "terminal HTTP retries");

    const calls = sendCalls(f.bot);
    expect(calls.every(call => call.body.chat_id === String(chat) && call.body.parse_mode === "HTML")).toBe(true);
    expect(calls.map(call => call.body.text)).toEqual(Array(4).fill(calls[0].body.text));
    expect(calls[0].body.reply_markup.inline_keyboard[0][0].text).toBe("Mute this session 1h");
    expect(visibleText(calls[0].body.text)).toContain("Can I use <this> & that?");
  });
});

describe("Telegram topic binding and forum replies", () => {
  test.each(["/bind@DASH_TEST_BOT invest", "/bind invest"])("bootstraps an unbound supergroup with %s", async command => {
    const f = await pairedFixture({ topicsEnabled: true });
    f.bot.enqueue(groupMessage(command, 42));
    await eventually(() => !!f.db.getSetting("telegram.topics"), "saved topic binding");
    await apiSettled(() => sendCalls(f.bot).length === 1, "binding confirmation");

    expect(JSON.parse(f.db.getSetting("telegram.topics")!)).toEqual({ groupChatId: String(group), topics: { invest: 42 } });
    const call = sendCalls(f.bot)[0];
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
  });

  test("binds from inside a topic when Telegram marks the command as a reply to the topic root", async () => {
    const f = await pairedFixture({ topicsEnabled: true });
    f.bot.enqueue(groupMessage("/bind@DASH_TEST_BOT invest", 42, { is_topic_message: true,
      reply_to_message: { message_id: 42, forum_topic_created: { name: "invest" } } }));
    await eventually(() => !!f.db.getSetting("telegram.topics"), "saved topic binding");
    await apiSettled(() => sendCalls(f.bot).length === 1, "binding confirmation");

    expect(JSON.parse(f.db.getSetting("telegram.topics")!)).toEqual({ groupChatId: String(group), topics: { invest: 42 } });
    expect(sendCalls(f.bot)[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
  });

  test("answers /status in a bound topic when Telegram marks it as a reply to the topic root", async () => {
    const f = await topicFixture();
    seedTopicQuestion(f.db, "invest-root", "invest", f.clock.now);
    f.bot.enqueue(groupMessage("/status@DASH_TEST_BOT", 42, { is_topic_message: true,
      reply_to_message: { message_id: 42, forum_topic_created: { name: "invest" } } }));
    await apiSettled(() => sendCalls(f.bot).length === 1, "topic status");

    expect(sendCalls(f.bot)[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
    expect(visibleText(sendCalls(f.bot)[0].body.text)).toContain("Session invest-root");
  });

  test("still ignores plain owner text that only replies to the topic root", async () => {
    const f = await topicFixture({ repliesEnabled: true });
    const row = seedTopicQuestion(f.db, "root-text", "invest", f.clock.now);
    f.db.rememberAlert(String(group), 42, row.key, "alert", f.clock.now);
    f.bot.enqueue(groupMessage("hello there", 42, { is_topic_message: true,
      reply_to_message: { message_id: 42, forum_topic_created: { name: "invest" } } }));
    await eventually(() => f.db.getSetting("telegram.offset") === "2", "root text ignored");

    expect(f.db.queuedReplies()).toHaveLength(0);
    expect(sendCalls(f.bot)).toEqual([]);
  });

  test("ignores untrusted bootstrap commands and refuses a second group", async () => {
    const f = await pairedFixture({ topicsEnabled: true });
    f.bot.enqueue(groupMessage("/status", 42));
    f.bot.enqueue(groupMessage("/bind invest", 42, { from: { id: owner + 1 } }));
    f.bot.enqueue(groupMessage("/bind@OtherBot invest", 42));
    f.bot.enqueue(groupMessage("/bind invest", 42));
    f.bot.enqueue(groupMessage("/bind defense", 56, { chat: { id: group - 1, type: "supergroup", title: "Other group" } }));
    await eventually(() => f.db.getSetting("telegram.offset") === "6", "bootstrap updates");
    await apiSettled(() => sendCalls(f.bot).length === 1, "only the authorized bind confirmation");

    expect(JSON.parse(f.db.getSetting("telegram.topics")!)).toEqual({ groupChatId: String(group), topics: { invest: 42 } });
    expect(sendCalls(f.bot).map(call => call.method)).toEqual(["sendMessage"]);
    expect(sendCalls(f.bot)[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
  });

  test("stores a topic bound from General as null and confirms the General placement", async () => {
    const f = await topicFixture();
    f.bot.enqueue(groupMessage("/bind general"));
    await eventually(() => JSON.parse(f.db.getSetting("telegram.topics")!).topics.general === null, "General binding");
    await apiSettled(() => sendCalls(f.bot).length === 1, "General binding confirmation");

    const call = sendCalls(f.bot)[0];
    expect(call.body.chat_id).toBe(String(group));
    expect(call.body).not.toHaveProperty("message_thread_id");
  });

  test("normalizes inbound General thread ID one to a null binding", async () => {
    const f = await topicFixture();
    f.bot.enqueue(groupMessage("/bind rogue", 1));
    await eventually(() => JSON.parse(f.db.getSetting("telegram.topics")!).topics.rogue === null, "thread one normalized");
    await apiSettled(() => sendCalls(f.bot).length === 1, "thread one confirmation");

    const call = sendCalls(f.bot)[0];
    expect(call.body.chat_id).toBe(String(group));
    expect(call.body).not.toHaveProperty("message_thread_id");
    expect(JSON.parse(f.db.getSetting("telegram.topics")!).topics).toMatchObject({ rogue: null });
  });

  test("unbinds one topic and replies in the command topic", async () => {
    const f = await topicFixture();
    f.bot.enqueue(groupMessage("/unbind invest", 42));
    await eventually(() => !Object.hasOwn(JSON.parse(f.db.getSetting("telegram.topics")!).topics, "invest"), "invest unbound");
    await apiSettled(() => sendCalls(f.bot).length === 1, "unbind confirmation");

    expect(JSON.parse(f.db.getSetting("telegram.topics")!).topics).toEqual({ general: null, "squad/rogue": 74, urgent: 90, defense: 56 });
    const call = sendCalls(f.bot)[0];
    expect(call.method).toBe("sendMessage");
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 42,
      text: "Unbound <b>invest</b>.", parse_mode: "HTML", disable_web_page_preview: true });
  });

  test("clears the group binding after unbinding its final topic", async () => {
    const f = await topicFixture({ bindings: { groupChatId: String(group), topics: { invest: 42 } } });
    f.bot.enqueue(groupMessage("/unbind invest", 42));
    await eventually(() => f.db.getSetting("telegram.topics") === undefined, "last binding removed");
    await apiSettled(() => sendCalls(f.bot).length === 1, "last unbind confirmation");

    const call = sendCalls(f.bot)[0];
    expect(call.method).toBe("sendMessage");
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 42, text: "Unbound <b>invest</b>." });
  });

  test("bounds an unknown unbind response after HTML escaping", async () => {
    const f = await topicFixture();
    f.bot.enqueue(groupMessage(`/unbind ${"&".repeat(1_200)}`, 42));
    await apiSettled(() => sendCalls(f.bot).length === 1, "unknown binding response");

    const call = sendCalls(f.bot)[0];
    expect(call.method).toBe("sendMessage");
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 42, parse_mode: "HTML" });
    const visible = visibleText(call.body.text);
    expect(call.body.text).toContain("No binding named <b>");
    expect(call.body.text).toContain("&amp;".repeat(20));
    expect(visible).toContain("&".repeat(20));
    expect(visible.length).toBeLessThanOrEqual(4096);
  });

  test("clears topic bindings and scoped modes on unpair", async () => {
    const f = await topicFixture();
    f.db.setSetting("telegram.mode.invest", "turns");
    f.telegram.unpair();

    expect(f.db.getSetting("telegram.topics")).toBeUndefined();
    expect(f.db.getSetting("telegram.mode.invest")).toBeUndefined();
    expect(f.bot.calls.filter(call => call.method === "sendMessage")).toEqual([]);
  });

  test.each([
    ["/status@DASH_TEST_BOT", true],
    ["/status", true],
    ["/status@OtherBot", false],
  ] as const)("handles %s according to getMe username", async (command, accepted) => {
    const f = await topicFixture();
    f.bot.enqueue(groupMessage(command, 42));
    await eventually(() => f.db.getSetting("telegram.offset") === "2", "status update offset");
    if (accepted) await apiSettled(() => sendCalls(f.bot).length === 1, "authorized status send");

    expect(f.bot.calls.some(call => call.method === "getMe")).toBe(true);
    if (accepted) {
      const call = sendCalls(f.bot)[0];
      expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
    } else expect(sendCalls(f.bot)).toHaveLength(0);
  });

  test("ignores a foreign /cmd bot mention in a group topic", async () => {
    const f = await topicFixture();
    f.bot.enqueue(groupMessage("/cmd@OtherBot", 42));
    await eventually(() => f.db.getSetting("telegram.offset") === "2", "foreign command offset");

    expect(sendCalls(f.bot)).toHaveLength(0);
  });

  test("answers an authorized bound-group mute callback with the Bot API body", async () => {
    const f = await topicFixture();
    const row = seedTopicQuestion(f.db, "group-callback", "invest", f.clock.now);
    f.telegram.observe(row);
    await apiSettled(() => sendCalls(f.bot).length === 1, "topic alert");
    const callbackData = sendCalls(f.bot)[0].body.reply_markup.inline_keyboard[0][0].callback_data;
    f.bot.enqueueUpdate({ callback_query: { id: "group-callback", from: { id: owner },
      message: { chat: { id: group, type: "supergroup" }, message_thread_id: 42 }, data: callbackData } });
    await eventually(() => f.bot.count("answerCallbackQuery") === 1, "group callback answer");

    expect(f.bot.calls.filter(call => call.method === "answerCallbackQuery")).toEqual([{ method: "answerCallbackQuery",
      body: { callback_query_id: "group-callback", text: "Muted Session group-callback for 1h" } }]);
  });

  test("ignores non-owner and foreign-chat callbacks", async () => {
    const f = await topicFixture();
    const data = `ms:${shortId("synthetic-host|claude|session-1")}`;
    f.bot.enqueueUpdate({ callback_query: { id: "non-owner", from: { id: owner + 1 },
      message: { chat: { id: group, type: "supergroup" }, message_thread_id: 42 }, data } });
    f.bot.enqueueUpdate({ callback_query: { id: "foreign-chat", from: { id: owner },
      message: { chat: { id: group - 1, type: "supergroup" }, message_thread_id: 42 }, data } });
    await eventually(() => f.db.getSetting("telegram.offset") === "3", "ignored callback updates");

    expect(f.bot.calls.filter(call => call.method === "answerCallbackQuery")).toEqual([]);
    expect(sendCalls(f.bot)).toEqual([]);
  });

  test("ignores topic creation service replies without enqueueing or sending", async () => {
    const f = await topicFixture({ repliesEnabled: true });
    const row = seedTopicQuestion(f.db, "service-reply", "invest", f.clock.now);
    f.db.rememberAlert(String(group), 9, row.key, "alert", f.clock.now);
    f.bot.enqueue(groupMessage("", 42, { reply_to_message: { message_id: 9, forum_topic_created: { name: "Synthetic topic" } } }));
    await eventually(() => f.db.getSetting("telegram.offset") === "2", "service update ignored");

    expect(f.db.queuedReplies()).toHaveLength(0);
    expect(sendCalls(f.bot)).toEqual([]);
  });

  test("ignores empty service messages", async () => {
    const f = await topicFixture();
    f.bot.enqueue(groupMessage("", 42, { new_chat_title: "Synthetic service update" }));
    await eventually(() => f.db.getSetting("telegram.offset") === "2", "empty service update");

    expect(sendCalls(f.bot)).toEqual([]);
  });

  test("routes a real topic alert reply with the topic and owner message ID", async () => {
    const f = await topicFixture({ repliesEnabled: true });
    const row = seedTopicQuestion(f.db, "group-reply", "invest", f.clock.now);
    f.db.rememberAlert(String(group), 9, row.key, "alert", f.clock.now);
    f.bot.enqueue(groupMessage("Synthetic owner answer", 42, { message_id: 55, reply_to_message: { message_id: 9 } }));
    await eventually(() => f.db.queuedReplies().length === 1, "group reply queued");
    await apiSettled(() => sendCalls(f.bot).length === 1, "topic reply confirmation");
    await eventually(() => f.db.getReply(f.db.queuedReplies()[0].id)?.tgChatId === String(group), "topic reply confirmation saved");

    expect(f.db.queuedReplies()[0].sessionKey).toBe(row.key);
    expect(f.db.getReply(f.db.queuedReplies()[0].id)?.tgChatId).toBe(String(group));
    expect(sendCalls(f.bot)).toEqual([{ method: "sendMessage", body: {
      chat_id: String(group), message_thread_id: 42,
      text: "📨 Queued for <b>Session group-reply</b> · synthetic-host", parse_mode: "HTML", disable_web_page_preview: true,
      reply_parameters: { message_id: 55, allow_sending_without_reply: true },
    } }]);
  });

  test("ignores historical DM replies and resolves a same-numbered group alert in its own chat", async () => {
    const f = await topicFixture({ repliesEnabled: true });
    const dm = seedTopicQuestion(f.db, "dm-alert", "unbound", f.clock.now);
    const groupRow = seedTopicQuestion(f.db, "group-alert", "invest", f.clock.now + 1);
    f.db.rememberAlert(String(chat), 9, dm.key, "alert", f.clock.now);
    f.db.rememberAlert(String(group), 9, groupRow.key, "alert", f.clock.now);
    f.bot.enqueue(message("DM answer", { message_id: 56, reply_to_message: { message_id: 9 } }));
    await eventually(() => f.db.getSetting("telegram.offset") === "2", "ignored DM reply");
    expect(f.db.queuedReplies()).toEqual([]);
    expect(sendCalls(f.bot)).toEqual([]);
    f.bot.enqueue(groupMessage("Group answer", 42, { message_id: 57, reply_to_message: { message_id: 9 } }));
    await apiSettled(() => sendCalls(f.bot).length === 1, "group reply confirmation");

    expect(f.db.queuedReplies().map(reply => reply.sessionKey)).toEqual([groupRow.key]);
    expect(sendCalls(f.bot)[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 42,
      reply_parameters: { message_id: 57, allow_sending_without_reply: true } });
  });

  test("edits a persisted reply confirmation in its actual group chat after restart", async () => {
    const f = await topicFixture({ repliesEnabled: true });
    const row = seedTopicQuestion(f.db, "restart-reply", "invest", f.clock.now);
    f.db.rememberAlert(String(group), 9, row.key, "alert", f.clock.now);
    f.bot.enqueue(groupMessage("Synthetic answer", 42, { message_id: 55, reply_to_message: { message_id: 9 } }));
    await eventually(() => f.db.queuedReplies().length === 1, "queued reply");
    await apiSettled(() => sendCalls(f.bot).length === 1, "sent confirmation");
    await eventually(() => f.db.getReply(f.db.queuedReplies()[0].id)?.tgChatId === String(group), "stored reply destination");
    const item = f.db.getReply(f.db.queuedReplies()[0].id)!;
    expect(item.tgChatId).toBe(String(group));
    f.telegram.close();
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => f.clock.now, replies: f.replies,
      topicsEnabled: true, readToken: async () => token, sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok", "restarted Telegram poller");
    again.replyOutcome(item, "delivered", row, 1);
    await apiSettled(() => f.bot.count("editMessageText") === 1, "stored confirmation edit");

    expect(f.bot.calls.filter(call => call.method === "editMessageText")).toEqual([{ method: "editMessageText", body: {
      chat_id: String(group), message_id: item.tgMsgId,
      text: "✅ Delivered to <b>Session restart-reply</b> · synthetic-host", parse_mode: "HTML", disable_web_page_preview: true,
    } }]);
  });

  test("rejects a basic group bind request with a same-chat Bot API reply", async () => {
    const f = await pairedFixture({ topicsEnabled: true });
    f.bot.enqueue(message("/bind invest", { chat: { id: group, type: "group", title: "Basic <group>" } }));
    await apiSettled(() => sendCalls(f.bot).length === 1, "basic group refusal");

    expect(f.db.getSetting("telegram.topics")).toBeUndefined();
    expect(sendCalls(f.bot)).toEqual([{ method: "sendMessage", body: {
      chat_id: String(group), text: "Use a supergroup with topics.", parse_mode: "HTML", disable_web_page_preview: true,
    } }]);
  });

});

describe("Telegram topic-scoped status, replies, and mode", () => {
  test("filters squad/rogue status and numbers needs-input before your-turn sessions", async () => {
    const f = await topicFixture();
    const rogue = seedTopicQuestion(f.db, "rogue-session", "rogue", f.clock.now - 1_000);
    const squad = seedTopicQuestion(f.db, "squad-session", "squad", f.clock.now - 2_000);
    const turn = seedTopicQuestion(f.db, "squad-turn", "squad", f.clock.now - 3_000);
    f.db.sqlite.query("UPDATE sessions SET status='your_turn',needs_reason=NULL,needs_text=NULL WHERE key=?").run(turn.key);
    seedTopicQuestion(f.db, "invest-session", "invest", f.clock.now - 4_000);
    f.bot.enqueue(groupMessage("/status", 74));
    await apiSettled(() => sendCalls(f.bot).length === 1, "squad/rogue status");

    const call = sendCalls(f.bot)[0];
    expect(call.method).toBe("sendMessage");
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 74 });
    const status = visibleText(call.body.text);
    expect(status).toMatch(/1\.\s+Session rogue-session\n(?=[^\n]*synthetic-host)(?=[^\n]*Waiting for you)[^\n]*/);
    expect(status).toMatch(/2\.\s+Session squad-session\n(?=[^\n]*synthetic-host)(?=[^\n]*Waiting for you)[^\n]*/);
    expect(status).toMatch(/3\.\s+Session squad-turn\n(?=[^\n]*synthetic-host)(?=[^\n]*Your turn)[^\n]*/);
    expect(status).not.toContain("invest-session");
  });

  test("moves a project out of squad/rogue when it has an exact topic binding", async () => {
    const f = await topicFixture({ bindings: { groupChatId: String(group), topics: { ...defaultTopics, rogue: 75 } } });
    seedTopicQuestion(f.db, "rogue-exact", "rogue", f.clock.now);
    seedTopicQuestion(f.db, "squad-exact", "squad", f.clock.now - 1);
    f.bot.enqueue(groupMessage("/status", 74));
    await apiSettled(() => sendCalls(f.bot).length === 1, "specific-topic status");

    const call = sendCalls(f.bot)[0];
    expect(call.method).toBe("sendMessage");
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 74 });
    const status = visibleText(call.body.text);
    expect(status).toMatch(/1\.\s+Session squad-exact\n(?=[^\n]*synthetic-host)(?=[^\n]*Waiting for you)[^\n]*/);
    expect(status).not.toContain("Session rogue-exact");
  });

  test("keeps project status topic-scoped and global status in General, never in DM", async () => {
    const f = await topicFixture();
    seedTopicQuestion(f.db, "invest-status", "invest", f.clock.now);
    seedTopicQuestion(f.db, "defense-status", "defense", f.clock.now - 1);
    f.bot.enqueue(groupMessage("/status", 42));
    await apiSettled(() => sendCalls(f.bot).length === 1, "invest status");
    f.bot.enqueue(message("/status"));
    await eventually(() => f.db.getSetting("telegram.offset") === "3", "ignored DM status");
    expect(sendCalls(f.bot)).toHaveLength(1);
    f.bot.enqueue(groupMessage("/status"));
    await apiSettled(() => sendCalls(f.bot).length === 2, "General status");

    const calls = sendCalls(f.bot);
    expect(calls.map(call => call.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(calls[0].body).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
    const investStatus = visibleText(calls[0].body.text);
    expect(investStatus).toContain("invest-status");
    expect(investStatus).not.toContain("defense-status");
    const globalStatus = visibleText(calls[1].body.text);
    expect(calls[1].body.chat_id).toBe(String(group));
    expect(calls[1].body).not.toHaveProperty("message_thread_id");
    expect(globalStatus).toContain("invest-status");
    expect(globalStatus).toContain("defense-status");
  });
  test("caps status at 15 numbered sessions and reports the total shown", async () => {
    const f = await pairedFixture();
    const names = Array.from({ length: 16 }, (_, index) => `status-overflow-${String(index).padStart(2, "0")}`);
    names.forEach((name, index) => seedTopicQuestion(f.db, name, "status", f.clock.now - index * 1_000));
    f.bot.enqueue(message("/status"));
    await apiSettled(() => sendCalls(f.bot).length === 1, "bounded status");

    const status = visibleText(sendCalls(f.bot)[0].body.text);
    expect(status.split("\n")[0]).toMatch(/status/i);
    expect(status).toMatch(/showing\s+15\s+of\s+16/i);
    expect(names.filter(name => status.includes(`Session ${name}`))).toHaveLength(15);
  });

  test("routes addressed /r to the numbered session from its topic status", async () => {
    const f = await topicFixture({ repliesEnabled: true });
    const rogue = seedTopicQuestion(f.db, "rogue-index", "rogue", f.clock.now - 1_000);
    const squad = seedTopicQuestion(f.db, "squad-index", "squad", f.clock.now - 2_000);
    const submitArgs: unknown[] = [];
    const submit = f.replies!.submit.bind(f.replies);
    f.replies!.submit = args => { submitArgs.push(args); return submit(args); };
    f.bot.enqueue(groupMessage("/status", 74));
    await apiSettled(() => sendCalls(f.bot).length === 1, "topic status snapshot");
    f.bot.enqueue(groupMessage("/r@dash_test_bot 2 hi", 74, { message_id: 101 }));
    await eventually(() => f.db.queuedReplies().length === 1, "topic indexed reply");
    await apiSettled(() => sendCalls(f.bot).length === 2, "topic reply confirmation");

    expect(f.db.queuedReplies()[0].sessionKey).toBe(squad.key);
    expect(f.db.queuedReplies()[0].sessionKey).not.toBe(rogue.key);
    expect(submitArgs).toEqual([{ key: squad.key, text: "hi", source: "telegram", actor: `telegram:${owner}`, listener: "telegram" }]);
    const call = sendCalls(f.bot)[1];
    expect(call).toEqual({ method: "sendMessage", body: {
      chat_id: String(group), message_thread_id: 74,
      text: "📨 Queued for <b>Session squad-index</b> · synthetic-host", parse_mode: "HTML", disable_web_page_preview: true,
      reply_parameters: { message_id: 101, allow_sending_without_reply: true },
    } });
  });

  test("does not reuse the squad snapshot for /r in invest", async () => {
    const f = await topicFixture({ repliesEnabled: true });
    seedTopicQuestion(f.db, "squad-only-index", "squad", f.clock.now);
    f.bot.enqueue(groupMessage("/status", 74));
    await apiSettled(() => sendCalls(f.bot).length === 1, "squad snapshot");
    f.bot.enqueue(groupMessage("/r 1 hi", 42, { message_id: 102 }));
    await apiSettled(() => sendCalls(f.bot).length === 2, "missing invest snapshot response");

    expect(f.db.queuedReplies()).toHaveLength(0);
    const call = sendCalls(f.bot)[1];
    expect(call.method).toBe("sendMessage");
    expect(call.body).toEqual({ chat_id: String(group), message_thread_id: 42, text: "Run /status first.",
      parse_mode: "HTML", disable_web_page_preview: true });
  });

  test("expires a topic reply index after 30 minutes", async () => {
    const clock = { now: 1_000_000 };
    const f = await topicFixture({ clock, repliesEnabled: true });
    seedTopicQuestion(f.db, "expired-index", "invest", clock.now);
    f.bot.enqueue(groupMessage("/status", 42));
    await apiSettled(() => sendCalls(f.bot).length === 1, "invest snapshot");
    clock.now += 30 * 60_000;
    f.bot.enqueue(groupMessage("/r 1 hi", 42, { message_id: 103 }));
    await apiSettled(() => sendCalls(f.bot).length === 2, "expired index response");

    expect(f.db.queuedReplies()).toHaveLength(0);
    expect(sendCalls(f.bot)[1].method).toBe("sendMessage");
    expect(sendCalls(f.bot)[1].body).toMatchObject({ chat_id: String(group), message_thread_id: 42, text: "Run /status first." });
  });

  test("keeps reply indexes independent between topics in one group chat", async () => {
    const f = await topicFixture({ repliesEnabled: true });
    const invest = seedTopicQuestion(f.db, "invest-index", "invest", f.clock.now);
    seedTopicQuestion(f.db, "defense-index", "defense", f.clock.now - 1);
    f.bot.enqueue(groupMessage("/status", 42));
    await apiSettled(() => sendCalls(f.bot).length === 1, "invest snapshot");
    f.bot.enqueue(groupMessage("/status", 56));
    await apiSettled(() => sendCalls(f.bot).length === 2, "defense snapshot");
    f.bot.enqueue(groupMessage("/r 1 hi", 42, { message_id: 104 }));
    await eventually(() => f.db.queuedReplies().length === 1, "invest reply after defense status");
    await apiSettled(() => sendCalls(f.bot).length === 3, "invest confirmation");

    expect(f.db.queuedReplies()[0].sessionKey).toBe(invest.key);
    const call = sendCalls(f.bot)[2];
    expect(call.method).toBe("sendMessage");
    expect(call.body).toMatchObject({ chat_id: String(group), message_thread_id: 42,
      text: "📨 Queued for <b>Session invest-index</b> · synthetic-host" });
  });

  test("stores scoped topic mode and changes global mode only from the group", async () => {
    const f = await topicFixture();
    f.bot.enqueue(groupMessage("/mode turns", 42));
    await eventually(() => f.db.getSetting("telegram.mode.invest") === "turns", "invest mode override");
    await apiSettled(() => sendCalls(f.bot).length === 1, "invest mode confirmation");
    f.bot.enqueue(groupMessage("/mode", 56));
    await apiSettled(() => sendCalls(f.bot).length === 2, "inherited defense mode");
    f.bot.enqueue(message("/mode off"));
    await eventually(() => f.db.getSetting("telegram.offset") === "4", "ignored DM mode");
    expect(f.db.getSetting("telegram.mode")).toBeUndefined();
    f.bot.enqueue(groupMessage("/mode off"));
    await eventually(() => f.db.getSetting("telegram.mode") === "off", "global General mode");
    await apiSettled(() => sendCalls(f.bot).length === 3, "global mode confirmation");

    expect(f.db.getSetting("telegram.mode")).toBe("off");
    expect(f.db.getSetting("telegram.mode.defense")).toBeUndefined();
    expect(f.db.getSetting("telegram.mode.invest")).toBe("turns");
    expect(sendCalls(f.bot).map(call => [call.body.chat_id, call.body.message_thread_id ?? null])).toEqual([
      [String(group), 42], [String(group), 56], [String(group), null],
    ]);
  });
});

describe("Telegram owner commands", () => {
  test("groups /help commands one command per line", async () => {
    const f = await pairedFixture();
    f.bot.enqueue(message("/help"));
    await apiSettled(() => f.bot.sent.length === 1, "grouped help");

    const lines = visibleText(f.bot.sent[0].text).split("\n");
    const commands = ["/status", "/mode", "/mute", "/r", "/cancel", "/help"];
    const commandMentions = lines.map(line => commands.filter(command => line.includes(command))).filter(found => found.length > 0);
    for (const command of commands) expect(commandMentions.some(found => found.includes(command))).toBe(true);
    expect(commandMentions.every(found => found.length === 1)).toBe(true);
    expect(lines.length).toBeGreaterThan(commands.length);
  });
  test.each(["input", "turns", "off"])("stores /mode %s", async mode => {
    const f = await pairedFixture();
    f.bot.enqueue(message(`/mode ${mode}`));
    await eventually(() => f.db.getSetting("telegram.mode") === mode);
    expect(f.telegram.health().mode).toBe(mode);
  });
  test("stores /mute 30m", async () => {
    const f = await pairedFixture();
    f.bot.enqueue(message("/mute 30m"));
    await eventually(() => !!f.db.getSetting("telegram.mute_until"));
    expect(Number(f.db.getSetting("telegram.mute_until"))).toBe(f.clock.now + 30 * 60_000);
  });
  test.each([["1h", 3_600_000], ["4h", 14_400_000], ["off", 0]] as const)("stores /mute %s", async (duration, ms) => {
    const f = await pairedFixture();
    f.bot.enqueue(message(`/mute ${duration}`));
    await eventually(() => f.db.getSetting("telegram.mute_until") !== undefined);
    expect(Number(f.db.getSetting("telegram.mute_until"))).toBe(ms ? f.clock.now + ms : 0);
  });
  test("answers replies while disabled without storing their text", async () => {
    const f = await pairedFixture();
    f.bot.enqueue(message("synthetic response text", { reply_to_message: { message_id: 1 } }));
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent[0].text).toBe("Replies are off on the hub.");
    expect(f.db.countResponses()).toBe(0);
  });
  test("answers an unknown mute callback as expired", async () => {
    const f = await pairedFixture();
    f.bot.enqueueUpdate({ callback_query: { id: "cb1", from: { id: owner }, message: { chat: { id: chat, type: "private" } }, data: "ms:ffffffffffff" } });
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(f.bot.calls.find(call => call.method === "answerCallbackQuery")?.body.text).toBe("Expired");
  });
  test("mutes a known session for one hour through its callback", async () => {
    const f = await pairedFixture();
    const row = f.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "session-1", kind: "question", ts: f.clock.now, text: "Question", interactive: true });
    f.telegram.observe(row);
    await apiSettled(() => f.bot.sent.length === 1);
    const id = f.bot.sent[0].reply_markup.inline_keyboard[0][0].callback_data;
    f.bot.enqueueUpdate({ callback_query: { id: "cb1", from: { id: owner }, message: { chat: { id: chat, type: "private" } }, data: id } });
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(f.bot.calls.find(call => call.method === "answerCallbackQuery")?.body.text).toContain("Muted");
    f.telegram.observe(dto("working"));
    f.telegram.observe(dto("needs_input"));
    expect(f.bot.sent).toHaveLength(1);
  });
  test("evicts the oldest callback id and refreshes recency for a repeated session", async () => {
    const clock = { now: 1_000_000 };
    const f = await pairedFixture({ clock, sleep: async ms => { clock.now += ms; } });
    const rows: SessionDTO[] = [];
    for (let i = 0; i < 501; i++) {
      rows.push(f.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: `session-${i}`, kind: "question", ts: clock.now + i, text: `Question ${i}`, interactive: true }));
      f.telegram.observe(rows[i]);
      await apiSettled(() => f.bot.sent.length === i + 1, `alert ${i + 1}`);
    }
    const first = f.bot.sent[0].reply_markup.inline_keyboard[0][0].callback_data;
    const refreshed = f.bot.sent[1].reply_markup.inline_keyboard[0][0].callback_data;
    const newest = f.bot.sent[500].reply_markup.inline_keyboard[0][0].callback_data;
    f.telegram.observe({ ...rows[1], status: "working" });
    f.telegram.observe(rows[1]);
    await apiSettled(() => f.bot.sent.length === 502, "re-alert for recency");
    const refreshedAgain = f.bot.sent[501].reply_markup.inline_keyboard[0][0].callback_data;
    expect(refreshedAgain).toBe(refreshed);

    f.bot.enqueueUpdate({ callback_query: { id: "cb-old", from: { id: owner }, message: { chat: { id: chat, type: "private" } }, data: first } });
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    f.bot.enqueueUpdate({ callback_query: { id: "cb-refreshed", from: { id: owner }, message: { chat: { id: chat, type: "private" } }, data: refreshed } });
    await eventually(() => f.bot.count("answerCallbackQuery") === 2);
    f.bot.enqueueUpdate({ callback_query: { id: "cb-newest", from: { id: owner }, message: { chat: { id: chat, type: "private" } }, data: newest } });
    await eventually(() => f.bot.count("answerCallbackQuery") === 3);
    expect(f.bot.calls.filter(call => call.method === "answerCallbackQuery").map(call => call.body.text)).toEqual([
      "Expired", "Muted session-1 for 1h", "Muted session-500 for 1h",
    ]);
  });
});

describe("Telegram reply routing", () => {
  const seed = (db: DashDB, name: string, harness: "claude" | "omp" = "claude", reason = "waiting") => {
    const row = db.applyEvent({ host: "synthetic-host", harness, sessionId: name, kind: "question", ts: 1_000_000, text: "Synthetic question", interactive: true });
    db.sqlite.query("UPDATE sessions SET needs_reason=?,display_name=? WHERE key=?").run(reason, `Project <${name}>`, row.key);
    return db.getSession(row.key)!;
  };
  const answer = (text: string, alertId: number, id = 10) => message(text, { message_id: id, reply_to_message: { message_id: alertId } });

  test("routes an alert reply, persists its id, and edits delivered confirmation", async () => {
    const f = await pairedFixture({ repliesEnabled: true, ttlMs: 10_000 });
    const row = seed(f.db, "one");
    f.telegram.observe(row);
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    f.bot.enqueue(answer("Owner answer", 1));
    await eventually(() => f.db.queuedReplies().length === 1);
    const item = f.db.queuedReplies()[0];
    await eventually(() => !!f.db.getReply(item.id)?.tgMsgId);
    expect(f.bot.sent[1].reply_parameters).toEqual({ message_id: 10, allow_sending_without_reply: true });
    expect(visibleText(f.bot.sent[1].text)).toContain("Project <one>");
    const ready = f.db.applyEvent({ host: row.host, harness: row.harness, sessionId: row.sessionId, kind: "response", ts: f.clock.now, interactive: true });
    f.replies!.observe(ready);
    const delivered = await f.replies!.waitClaude(row.key, "waiteraaaaaaaaaa", 1, 100);
    expect(delivered.status).toBe(200);
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    expect(f.bot.calls.find(call => call.method === "editMessageText")?.body.text).toBe("✅ Delivered to <b>Project &lt;one&gt;</b> · synthetic-host");
    expect(f.db.getReply(item.id)?.text).toBe("");
  });

  test("immediate delivery is reflected after the queued confirmation is sent", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    const row = seed(f.db, "instant");
    const ready = f.db.applyEvent({ host: row.host, harness: row.harness, sessionId: row.sessionId, kind: "response", ts: f.clock.now, interactive: true });
    f.db.rememberAlert(String(chat), 91, ready.key, "alert", f.clock.now);
    const pending = f.replies!.waitClaude(ready.key, "waiteraaaaaaaaaa", 1, 1000);
    f.bot.enqueue(answer("instant reply", 91));
    expect((await pending).status).toBe(200);
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    expect(f.bot.calls.find(call => call.method === "editMessageText")?.body.text).toBe("✅ Delivered to <b>Project &lt;instant&gt;</b> · synthetic-host");
  });

  test("a reply without text (photo, sticker) is refused and nothing is queued", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    const row = seed(f.db, "empty");
    f.db.rememberAlert(String(chat), 92, row.key, "alert", f.clock.now);
    f.bot.enqueue(message("", { message_id: 11, reply_to_message: { message_id: 92 } }));
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent[0].text).toBe("Only text replies can be sent to a session.");
    expect(f.db.queuedReplies()).toHaveLength(0);
  });

  test("digest and unknown replies get a hint; ended and unsupported dialogs are refused", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    f.db.rememberAlert(String(chat), 20, null, "digest", f.clock.now);
    f.bot.enqueue(answer("reply", 20, 11));
    f.bot.enqueue(answer("reply", 999, 12));
    await apiSettled(() => f.bot.sent.length === 2);
    expect(f.bot.sent.every(send => send.text.includes("/status then /r N"))).toBe(true);
    const ended = seed(f.db, "ended");
    f.db.applyEvent({ host: ended.host, harness: ended.harness, sessionId: ended.sessionId, kind: "session_end", ts: f.clock.now, interactive: true });
    f.db.rememberAlert(String(chat), 21, ended.key, "alert", f.clock.now);
    f.bot.enqueue(answer("reply", 21, 13));
    await apiSettled(() => f.bot.sent.length === 3);
    expect(f.bot.sent[2].text).toBe("That session has ended.");
    f.db.rememberAlert(String(chat), 22, "synthetic-host|claude|missing-session", "alert", f.clock.now);
    f.bot.enqueue(answer("reply", 22, 14));
    await apiSettled(() => f.bot.sent.length === 4);
    expect(f.bot.sent[3].text).toBe("That session could not be found.");
    for (const reason of ["question", "permission", "permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]) {
      const row = seed(f.db, reason, "claude", reason);
      const alertId = 30 + f.bot.sent.length;
      f.db.rememberAlert(String(chat), alertId, row.key, "alert", f.clock.now);
      f.bot.enqueue(answer("reply", alertId, alertId + 100));
      const count = f.bot.sent.length + 1;
      await apiSettled(() => f.bot.sent.length === count);
      expect(f.bot.sent.at(-1)!.text).toBe("Claude dialogs can't be answered by a free-text reply. Use AskUserQuestion buttons when available; answer permission prompts in the terminal or Remote Control.");
    }
    const omp = seed(f.db, "omp", "omp", "permission");
    f.db.rememberAlert(String(chat), 99, omp.key, "alert", f.clock.now);
    f.bot.enqueue(answer("reply", 99, 200));
    await eventually(() => f.bot.sent.at(-1)?.text === "omp tool approvals can't be answered from dash yet.");
    expect(f.db.queuedReplies()).toHaveLength(0);
  });

  test("/status numbers needs input then your turn; /r uses the latest map and /cancel edits", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    f.bot.enqueue(message("/r 2 hi"));
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent[0].text).toBe("Run /status first.");
    const one = seed(f.db, "one");
    const two = seed(f.db, "two");
    f.db.applyEvent({ host: one.host, harness: one.harness, sessionId: one.sessionId, kind: "response", ts: f.clock.now, interactive: true });
    f.bot.enqueue(message("/status"));
    await apiSettled(() => f.bot.sent.length === 2);
    const status = visibleText(f.bot.sent[1].text);
    expect(status).toMatch(/1\.\s+Project <two>\n/);
    expect(status).toMatch(/2\.\s+Project <one>\n/);
    f.bot.enqueue(message("/r 2 hi", { message_id: 15 }));
    await eventually(() => f.db.queuedReplies().length === 1);
    const item = f.db.queuedReplies()[0];
    expect(item.sessionKey).toBe(one.key);
    expect(item.source).toBe("telegram");
    expect(item.actor).toBe(`telegram:${owner}`);
    await eventually(() => !!f.db.getReply(item.id)?.tgMsgId);
    f.bot.enqueue(message("/cancel"));
    await eventually(() => f.db.getReply(item.id)?.state === "cancelled");
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    expect(f.bot.calls.find(call => call.method === "editMessageText")?.body.text).toBe("✖️ Cancelled.");
    await eventually(() => f.bot.sent.at(-1)?.text === "Cancelled 1 pending replies.");
    expect(f.bot.calls.filter(call => call.method === "sendMessage").at(-1)).toEqual({ method: "sendMessage", body: {
      chat_id: String(chat), text: "Cancelled 1 pending replies.", parse_mode: "HTML", disable_web_page_preview: true,
    } });
  });

  test("expiry and ended session edit confirmations; a non-owner is ignored", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    const row = seed(f.db, "expire");
    f.db.rememberAlert(String(chat), 41, row.key, "alert", f.clock.now);
    f.bot.enqueue(answer("reply", 41));
    await eventually(() => !!f.db.queuedReplies()[0]?.tgMsgId);
    f.clock.now += 1001;
    f.replies!.sweep();
    await apiSettled(() => f.bot.count("editMessageText") === 1);
    expect(f.bot.calls.find(call => call.method === "editMessageText")?.body.text).toContain("wasn't ready within 1 min");
    f.bot.enqueue(answer("reply", 41, 12));
    await eventually(() => f.db.queuedReplies().length === 1);
    f.replies!.observe(f.db.applyEvent({ host: row.host, harness: row.harness, sessionId: row.sessionId, kind: "session_end", ts: f.clock.now, interactive: true }));
    await apiSettled(() => f.bot.count("editMessageText") === 2);
    expect(f.bot.calls.filter(call => call.method === "editMessageText")[1].body.text).toContain("ended.");
    const sent = f.bot.sent.length;
    f.bot.enqueue(message("reply", { from: { id: owner + 1 }, reply_to_message: { message_id: 41 } }));
    await eventually(() => f.db.getSetting("telegram.offset") === "4");
    expect(f.bot.sent.length).toBe(sent);
  });

  test("a new Telegram instance routes a reply using persisted alert ids", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    const row = seed(f.db, "reopen");
    f.telegram.observe(row);
    await eventually(() => !!f.db.alertFor(String(chat), 1));
    f.telegram.close();
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => f.clock.now, replies: f.replies,
      readToken: async () => token, sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok");
    f.bot.enqueue(answer("persisted", 1));
    await eventually(() => f.db.queuedReplies().length === 1);
    expect(f.db.queuedReplies()[0].sessionKey).toBe(row.key);
  });
});

describe("Telegram turn alerts and card lifecycle", () => {
  type F = Awaited<ReturnType<typeof pairedFixture>>;
  const base = { host: "synthetic-host", harness: "claude" as const, interactive: true };
  const ask = "Should I proceed?\nA. keep the refactor\nB. rebuild it (Recommended)";
  const respond = (f: F, sessionId: string, text: string, cwd?: string) => {
    f.telegram.observe(f.db.applyEvent({ ...base, sessionId, cwd, kind: "prompt", ts: ++f.clock.now, text: "Synthetic prompt" }), "prompt");
    const row = f.db.applyEvent({ ...base, sessionId, cwd, kind: "response", ts: ++f.clock.now, text });
    f.telegram.observe(row, "response");
    return row;
  };
  const tap = (f: F, data: string, messageId: number, overrides: Record<string, any> = {}) => f.bot.enqueueUpdate({ callback_query: {
    id: `cb-${f.bot.calls.length}`, from: { id: owner }, message: { message_id: messageId, chat: { id: chat, type: "private" } }, data, ...overrides } });
  const goData = (f: F, row: SessionDTO) => `d:${f.db.cardForTurn(row.key, row.turnSeq)!.id.toString(36)}:0:1`;
  const answers = (f: F) => f.bot.calls.filter(call => call.method === "answerCallbackQuery").map(call => call.body.text);
  const replyRows = (f: F) => (f.db.sqlite.query("SELECT COUNT(*) AS n FROM replies").get() as { n: number }).n;
  const settle = async (f: F) => {
    const offset = Number(f.db.getSetting("telegram.offset") ?? 0) + 1;
    f.bot.enqueue(message("ignored", { message_id: 900 + offset, from: { id: owner + 1 } }));
    await eventually(() => Number(f.db.getSetting("telegram.offset")) >= offset, "processed updates");
  };

  test("plain turn alerts offer no generic recommendation action and reject retired taps", async () => {
    const f = await pairedFixture({ mode: "turns", repliesEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "plain", "Finished the migration.");
    await apiSettled(() => f.bot.sent.length === 1);
    const card = f.db.cardForTurn(row.key, row.turnSeq)!;
    expect(f.bot.sent[0].reply_markup.inline_keyboard.flat().map((button: { callback_data: string }) => button.callback_data))
      .toEqual([`ms:${shortId(row.key)}`]);
    for (const option of [1, 2]) tap(f, `d:${card.id.toString(36)}:99:${option}`, 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 2);
    expect(replyRows(f)).toBe(0);
    expect(f.db.getCard(card.id)!.state).toBe("active");
    expect(f.bot.count("editMessageText")).toBe(0);
  });

  test("input mode alerts once for a prose question and never for a plain finished turn", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    respond(f, "plain", "Done with the refactor. All tests pass.");
    const row = respond(f, "asker", "Done with the refactor. Should I proceed?");
    await apiSettled(() => f.bot.sent.length === 1);
    await settle(f);
    expect(visibleText(f.bot.sent[0].text)).toContain("asker");
    expect(f.bot.sent[0].reply_markup.inline_keyboard.flat().map((button: { callback_data: string }) => button.callback_data))
      .toEqual([`ms:${shortId(row.key)}`]);
    expect(f.db.cardForTurn(f.db.listSessions().find(s => s.displayName === "plain")!.key, 1)).toBeUndefined();
  });

  test("without replies, input mode stays silent and turns-mode alerts have no button", async () => {
    const quiet = await pairedFixture();
    respond(quiet, "asker", ask);
    await settle(quiet);
    expect(quiet.bot.sent.filter(send => send.reply_markup)).toHaveLength(0);
    const turns = await pairedFixture({ mode: "turns" });
    const row = respond(turns, "asker", ask);
    await apiSettled(() => turns.bot.sent.length === 1);
    expect(turns.bot.sent[0].reply_markup.inline_keyboard).toHaveLength(1);
    expect(turns.db.cardForTurn(row.key, row.turnSeq)).toBeUndefined();
  });

  test("three simultaneous answerable alerts never become a digest", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true });
    const rows = ["one", "two", "three"].map(name => respond(f, name, ask));
    await apiSettled(() => f.bot.sent.length === 3);
    expect(f.bot.sent.every(send => !visibleText(send.text).includes("Session updates"))).toBe(true);
    expect(f.bot.sent.map(send => send.reply_markup.inline_keyboard[0][1].callback_data)).toEqual(rows.map(row => goData(f, row)));
  });

  test("a Claude question alert shows its (Recommended) option label", async () => {
    // Event rows older than seven days of wall time are pruned, so the question events use real timestamps.
    const f = await pairedFixture({ repliesEnabled: true, clock: { now: Date.now() } });
    f.telegram.observe(f.db.applyEvent({ ...base, sessionId: "labelled", kind: "question", ts: ++f.clock.now, text: "Pick one?",
      detail: JSON.stringify([[{ label: "Keep <it>" }, { label: "Rebuild (Recommended)" }]]) }));
    f.telegram.observe(f.db.applyEvent({ ...base, sessionId: "unlabelled", kind: "question", ts: ++f.clock.now, text: "Pick one?",
      detail: JSON.stringify([[{ label: "Keep" }, { label: "Rebuild" }]]) }));
    await apiSettled(() => f.bot.sent.length === 2);
    expect(f.bot.sent[0].text).toContain("⭐ <b>Recommended</b> (agent's words): Rebuild (Recommended)");
    expect(f.bot.sent[1].text).not.toContain("Recommended");
  });

  test("needs-input alerts never carry the button", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    f.telegram.observe(f.db.applyEvent({ ...base, sessionId: "dialog", kind: "question", ts: ++f.clock.now, text: "Pick one?" }));
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent[0].reply_markup.inline_keyboard).toEqual([[{ text: "Mute this session 1h", callback_data: `ms:${shortId("synthetic-host|claude|dialog")}` }]]);
    expect(f.db.sqlite.query("SELECT COUNT(*) AS n FROM tg_cards").get()).toEqual({ n: 0 });
  });

  test("recommendation line: agent's words, verified, escaped, redacted and taken from the full text", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, snippetChars: 40 });
    const secret = `sk-${"a".repeat(30)}`;
    respond(f, "words", `${"Long preamble words. ".repeat(10)}\n\nI recommend <img src=x onerror=alert(1)> with token: ${secret}. Should I proceed?`);
    respond(f, "verified", "Which approach should we take?\nA. use the cache\nB. rebuild the index (recommended)");
    await apiSettled(() => f.bot.sent.length === 2);
    const [words, verified] = f.bot.sent.map(send => send.text as string);
    expect(words).toContain("⭐ <b>Recommended</b> (agent's words): I recommend &lt;img src=x onerror=alert(1)&gt; with token: [redacted]\n");
    expect(words).not.toContain(secret);
    expect(words).not.toContain("<img");
    expect(visibleText(words)).toContain("Excerpt limited by DASH_TELEGRAM_SNIPPET_CHARS");
    expect(verified).toContain("⭐ <b>Recommended:</b> Which approach should we take? → B (rebuild the index)");
    expect(words.length).toBeLessThanOrEqual(4096);
  });

  test("an oversized quote shrinks until the page fits Telegram's limit", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    respond(f, "huge", `${"&".repeat(2900)}\n\nI recommend ${"<&> ".repeat(120)}now. Should I?`);
    await apiSettled(() => f.bot.sent.length >= 1);
    await settle(f);
    const last = f.bot.sent.at(-1)!;
    expect(last.text.length).toBeLessThanOrEqual(4096);
    expect(last.text).toContain("(agent's words): I recommend");
  });

  test("callbacks from a foreign user or chat get no answer and change nothing", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "guarded", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    tap(f, goData(f, row), 1, { from: { id: owner + 1 } });
    tap(f, goData(f, row), 1, { message: { message_id: 1, chat: { id: chat + 1, type: "private" } } });
    await settle(f);
    expect(f.bot.count("answerCallbackQuery")).toBe(0);
    expect(replyRows(f)).toBe(0);
    expect(f.db.cardForTurn(row.key, row.turnSeq)!.state).toBe("active");
  });

  test("a wrong message, unknown card or malformed code answers Expired without mutation", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "expired", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    const id = f.db.cardForTurn(row.key, row.turnSeq)!.id.toString(36);
    for (const [data, messageId] of [[`d:${id}:0:1`, 2], ["d:zz:0:1", 1], [`d:${id}:0:01`, 1], [`d:${id}:99:6`, 1],
      [`d:${id}:0:2`, 1], [`d:${id}:99:-2`, 1], ["d:123456789:0:1", 1], [`d:${id.toUpperCase()}x:0:1`, 1]] as const) tap(f, data, messageId);
    await eventually(() => f.bot.count("answerCallbackQuery") === 8);
    expect(new Set(answers(f))).toEqual(new Set(["Expired, use /status"]));
    expect(replyRows(f)).toBe(0);
    expect(f.db.cardForTurn(row.key, row.turnSeq)!.state).toBe("active");
  });

  test("ignores a group card replayed in DM with the same message id", async () => {
    const f = await topicFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "group-card", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.db.cardForTurn(row.key, row.turnSeq)).toMatchObject({ chatId: String(group), messageId: 1, state: "active" });
    tap(f, goData(f, row), 1);
    await eventually(() => f.db.getSetting("telegram.offset") === "2", "ignored DM callback");
    expect(answers(f)).toEqual([]);
    expect(replyRows(f)).toBe(0);
    expect(f.db.cardForTurn(row.key, row.turnSeq)!.state).toBe("active");
  });

  test("an active card past its 24h expiry answers Expired without mutation", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "old-card", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    const card = f.db.cardForTurn(row.key, row.turnSeq)!;
    expect(card.expiresAt).toBe(card.createdAt + 86_400_000);
    f.clock.now = card.expiresAt;
    tap(f, goData(f, row), 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(answers(f)).toEqual(["Expired, use /status"]);
    expect(replyRows(f)).toBe(0);
    expect(f.db.getCard(card.id)!.state).toBe("active");
    expect(f.bot.count("editMessageReplyMarkup")).toBe(0);
  });

  test("a failed send marks the card failed and a topic fallback binds the card to General", async () => {
    const failed = { status: 400, body: { ok: false, error_code: 400, description: "synthetic failure text" } };
    const dm = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true });
    dm.bot.sendSequence = Array.from({ length: 4 }, () => failed);
    const lost = respond(dm, "lost", ask);
    await apiSettled(() => dm.bot.sent.length === 4 && dm.db.cardForTurn(lost.key, lost.turnSeq)?.state === "failed", "failed card");
    const f = await topicFixture({ repliesEnabled: true, decisionsEnabled: true });
    f.bot.sendSequence = [failed];
    const row = respond(f, "fallback", ask, "/projects/invest/synthetic");
    await apiSettled(() => f.bot.sent.length === 2 && f.db.cardForTurn(row.key, row.turnSeq)?.state === "active", "General card");
    expect(f.bot.sent[0]).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
    expect(f.db.cardForTurn(row.key, row.turnSeq)).toMatchObject({ chatId: String(group), threadId: null, messageId: 2 });
  });

  test("a card on a hub with replies off answers that for every option and changes nothing", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "rolled-back", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    const id = f.db.cardForTurn(row.key, row.turnSeq)!.id.toString(36);
    f.telegram.close();
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => f.clock.now,
      readToken: async () => token, sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok");
    for (const data of [`d:${id}:0:1`, ...[3, 4, 5].map(option => `d:${id}:99:${option}`)]) tap(f, data, 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 4);
    expect(new Set(answers(f))).toEqual(new Set(["Replies are off on the hub."]));
    expect(f.bot.sent).toHaveLength(1);
    expect(replyRows(f)).toBe(0);
    expect(f.db.cardForTurn(row.key, row.turnSeq)!.state).toBe("active");
  });

  test("a moved turn answers the stale toast, removes the keyboard and queues nothing", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "moved", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    const card = f.db.cardForTurn(row.key, row.turnSeq)!;
    f.db.applyEvent({ ...base, sessionId: "moved", kind: "response", ts: ++f.clock.now, text: "Another answer" });
    tap(f, goData(f, row), 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1 && f.bot.count("editMessageReplyMarkup") === 1);
    expect(answers(f)).toEqual(["Out of date: the session has moved on"]);
    expect(f.bot.calls.find(call => call.method === "editMessageReplyMarkup")!.body)
      .toEqual({ chat_id: String(chat), message_id: 1, reply_markup: { inline_keyboard: [] } });
    expect(f.db.getCard(card.id)!.state).toBe("stale");
    expect(replyRows(f)).toBe(0);
  });

  test("Full text and Mute each check freshness before any effect", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true });
    const rows = [respond(f, "full", ask), respond(f, "mute", ask)];
    await apiSettled(() => f.bot.sent.length === 2);
    const [full, mute] = rows.map(row => f.db.cardForTurn(row.key, row.turnSeq)!.id.toString(36));
    for (const sessionId of ["full", "mute"]) f.db.applyEvent({ ...base, sessionId, kind: "response", ts: ++f.clock.now, text: "Another answer" });
    tap(f, `d:${full}:99:4`, 1);
    tap(f, `d:${mute}:99:5`, 2);
    await eventually(() => f.bot.count("answerCallbackQuery") === 2);
    expect(answers(f)).toEqual(["Out of date: the session has moved on", "Out of date: the session has moved on"]);
    expect(f.bot.sent).toHaveLength(2);
    respond(f, "mute", ask);
    await apiSettled(() => f.bot.sent.length === 3, "unmuted alert");
  });

  test("a replayed tap produces exactly one reply", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "replay", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    tap(f, goData(f, row), 1);
    tap(f, goData(f, row), 1);
    tap(f, goData(f, row), 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 3);
    expect(replyRows(f)).toBe(1);
    expect(answers(f)).toEqual(["Sent to replay", "Expired, use /status", "Expired, use /status"]);
  });

  test("a synchronous Claude-waiter delivery ends at Delivered, never a late Sent", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "instant", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    const pending = f.replies!.waitClaude(row.key, "waiteraaaaaaaaaa", 1, 5_000);
    tap(f, goData(f, row), 1);
    const delivered = await pending;
    expect(delivered.status).toBe(200);
    await apiSettled(() => f.bot.count("editMessageText") >= 1 && f.bot.count("editMessageReplyMarkup") === 1, "card edits");
    await settle(f);
    const edits = f.bot.calls.filter(call => call.method === "editMessageText").map(call => visibleText(call.body.text));
    expect(edits.at(-1)).toMatch(/✅ Delivered$/);
    expect(edits.some(text => text.includes("✅ Sent"))).toBe(false);
  });

  test("a later outcome replaces Sent and a late Sent never overwrites it", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "later", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    tap(f, goData(f, row), 1);
    await apiSettled(() => f.bot.count("editMessageText") === 1, "sent edit");
    f.replies!.cancelAll();
    await apiSettled(() => f.bot.count("editMessageText") === 2, "cancelled edit");
    const card = f.db.cardForTurn(row.key, row.turnSeq)!;
    f.telegram.replyOutcome(f.db.getReply(card.replyId!)!, "delivered");
    await settle(f);
    const edits = f.bot.calls.filter(call => call.method === "editMessageText").map(call => visibleText(call.body.text));
    expect(edits).toHaveLength(2);
    expect(edits[1]).toMatch(/✖️ Cancelled$/);
    expect(edits[1]).not.toContain("✅ Sent");
  });

  test("Continue, Full text and Mute codes act on a fresh card", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const secret = `sk-${"b".repeat(30)}`;
    const row = respond(f, "codes", `Use <b>bold</b> carefully with ${secret}.\n\n${ask}`);
    await apiSettled(() => f.bot.sent.length === 1);
    const id = f.db.cardForTurn(row.key, row.turnSeq)!.id.toString(36);
    tap(f, `d:${id}:99:4`, 1);
    await apiSettled(() => f.bot.sent.length === 2, "full text");
    expect(f.bot.sent[1].text).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(f.bot.sent[1].text).toContain("[redacted]");
    expect(f.bot.sent[1].text).not.toContain(secret);
    tap(f, `d:${id}:99:5`, 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 2);
    expect(replyRows(f)).toBe(0);
    tap(f, `d:${id}:99:3`, 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 3);
    expect(answers(f)).toEqual(["Sending the full text.", "Muted codes for 1h", "Sent to codes"]);
    expect(f.db.queuedReplies().map(reply => [reply.text, reply.answersTurn])).toEqual([[CONTINUE_TEXT, row.turnSeq]]);
    respond(f, "codes", ask);
    await settle(f);
    expect(f.bot.sent).toHaveLength(2);
  });

  test("a waiting liveness alert after a decision card is suppressed", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true });
    const row = respond(f, "waiting", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    f.clock.now += 11_000;
    const [waiting] = f.db.markLiveness("claude", [{ sessionId: "waiting", detail: "waiting" }], row.host, f.clock.now);
    expect(waiting).toMatchObject({ status: "needs_input", needsReason: "waiting" });
    f.telegram.observe(waiting!);
    await settle(f);
    expect(f.bot.sent).toHaveLength(1);
  });

  test("an owner prompt that answers the turn another way stales its card, clears the keyboard and ends waiting suppression", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "answered", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    const card = f.db.cardForTurn(row.key, row.turnSeq)!;
    f.telegram.observe(f.db.applyEvent({ ...base, sessionId: "answered", kind: "prompt", ts: ++f.clock.now, text: "Synthetic typed answer" }), "prompt");
    expect(f.db.getCard(card.id)!.state).toBe("stale");
    await eventually(() => f.bot.calls.some(call => call.method === "editMessageReplyMarkup" && call.body.message_id === 1), "keyboard removed");
    tap(f, goData(f, row), 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(answers(f)).toEqual(["Expired, use /status"]);
    expect(replyRows(f)).toBe(0);
    f.clock.now += 11_000;
    const [waiting] = f.db.markLiveness("claude", [{ sessionId: "answered", detail: "waiting" }], row.host, f.clock.now);
    f.telegram.observe(waiting!);
    await apiSettled(() => f.bot.sent.length === 2, "waiting alert");
    expect(visibleText(f.bot.sent[1].text)).toContain("Waiting for you");
  });

  test("a card's own synchronously delivered reply never stales it: Sent, then Delivered", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000, observeReplies: true });
    const row = respond(f, "own", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    const card = f.db.cardForTurn(row.key, row.turnSeq)!;
    const pending = f.replies!.waitClaude(row.key, "waiteraaaaaaaaaa", 1, 5_000);
    tap(f, goData(f, row), 1);
    expect((await pending).status).toBe(200);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(answers(f)).toEqual(["Sent to own"]);
    expect(f.db.getCard(card.id)).toMatchObject({ state: "sent" });
    await settle(f);
    const edits = f.bot.calls.filter(call => call.method === "editMessageText").map(call => visibleText(call.body.text));
    expect(edits.at(-1)).toMatch(/✅ Delivered$/);
  });

  test("a delivered dashboard reply stales the turn's card and removes its keyboard", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000, observeReplies: true });
    const row = respond(f, "webreply", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    const card = f.db.cardForTurn(row.key, row.turnSeq)!;
    const pending = f.replies!.waitClaude(row.key, "waiterbbbbbbbbbb", 1, 5_000);
    expect("ok" in f.replies!.submit({ key: row.key, text: "Synthetic web answer", source: "web", actor: "web:loopback", answersTurn: row.turnSeq })).toBe(true);
    expect((await pending).status).toBe(200);
    expect(f.db.getCard(card.id)!.state).toBe("stale");
    await eventually(() => f.bot.calls.some(call => call.method === "editMessageReplyMarkup" && call.body.message_id === 1), "keyboard removed");
    expect(f.bot.calls.find(call => call.method === "editMessageReplyMarkup")!.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  test("a reply outcome after the alert was answered another way still replaces Sent", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "late", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    tap(f, goData(f, row), 1);
    await apiSettled(() => f.bot.count("editMessageText") === 1, "sent edit");
    f.telegram.observe(f.db.applyEvent({ ...base, sessionId: "late", kind: "prompt", ts: ++f.clock.now, text: "Synthetic typed answer" }), "prompt");
    await settle(f);
    expect(f.replies!.cancelAll()).toHaveLength(1);
    await eventually(() => /✖️ Cancelled$/.test(visibleText(f.bot.calls.filter(call => call.method === "editMessageText").at(-1)!.body.text)), "cancelled edit");
  });

  test("unpairing expires live cards, so their taps answer Expired", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "unpaired", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    const card = f.db.cardForTurn(row.key, row.turnSeq)!;
    expect(card.state).toBe("active");
    f.telegram.unpair();
    expect(f.db.getCard(card.id)!.state).toBe("expired");
  });

  test("a code-heavy last page keeps its A3 line: the budget counts visible text, not HTML", async () => {
    const f = await pairedFixture({ repliesEnabled: true });
    const fence = "```json\n" + '{"a":"b"},\n'.repeat(150) + "```";
    respond(f, "markup", `I recommend option B because it is safer.\n\n${fence}\n\nShould I proceed?`);
    await apiSettled(() => f.bot.sent.length >= 1);
    await settle(f);
    const last = f.bot.sent.at(-1)!;
    expect(last.text.length).toBeGreaterThan(4096);
    expect(visibleText(last.text).length).toBeLessThanOrEqual(4096);
    expect(visibleText(last.text)).toContain("⭐ Recommended (agent's words): I recommend option B because it is safer.");
  });

  test("a tap is stale once a newer backfilled message shadows the card's response", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "shadowed", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    f.db.addBackfill({ ...base, sessionId: "shadowed", responses: [{ ts: f.clock.now + 10_000, text: "Synthetic newer message: drop it or keep it?" }] } as any);
    expect(f.db.getSession(row.key)!.turnSeq).toBe(row.turnSeq);
    tap(f, goData(f, row), 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(answers(f)).toEqual(["Out of date: the session has moved on"]);
    expect(replyRows(f)).toBe(0);
  });

  test("a hook duplicate of a backfilled message is the live turn and gets its button", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true });
    f.db.addBackfill({ ...base, sessionId: "rebound", responses: [{ ts: f.clock.now - 5_000, text: ask }] } as any);
    const row = respond(f, "rebound", ask);
    expect(f.db.countResponses()).toBe(1);
    expect(f.db.responseForTurn(row.key, row.turnSeq)).toMatchObject({ source: "hook" });
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent[0].reply_markup.inline_keyboard[0][1].callback_data).toBe(goData(f, row));
  });

  test("cards stranded in pending by a shutdown are failed at startup and stop suppressing the waiting alert", async () => {
    const db = new DashDB(":memory:", { decisionsEnabled: true });
    const row = db.applyEvent({ ...base, sessionId: "stranded", kind: "response", ts: 999_000, text: ask });
    const intent = db.createCardIntent(row.key, row.lastResponses[0]!.id, row.turnSeq, { chatId: String(chat), threadId: null }, 900_000);
    const fresh = db.applyEvent({ ...base, sessionId: "fresh", kind: "response", ts: 999_001, text: ask });
    const recent = db.createCardIntent(fresh.key, fresh.lastResponses[0]!.id, fresh.turnSeq, { chatId: String(chat), threadId: null }, 999_990);
    if (intent === "card_id_overflow" || recent === "card_id_overflow") throw new Error("overflow");
    const f = await pairedFixture({ repliesEnabled: true, db });
    expect([f.db.getCard(intent.card.id)!.state, f.db.getCard(recent.card.id)!.state]).toEqual(["failed", "pending"]);
    f.clock.now += 11_000;
    const [waiting] = f.db.markLiveness("claude", [{ sessionId: "stranded", detail: "waiting" }], row.host, f.clock.now);
    f.telegram.observe(waiting!);
    await apiSettled(() => f.bot.sent.length === 1, "waiting alert");
  });

  test("a card survives a restart and a tap still submits", async () => {
    const f = await pairedFixture({ repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 });
    const row = respond(f, "restart", ask);
    await apiSettled(() => f.bot.sent.length === 1);
    f.telegram.close();
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => f.clock.now, replies: f.replies,
      readToken: async () => token, sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok");
    tap(f, goData(f, row), 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(f.db.queuedReplies()).toMatchObject([{ sessionKey: row.key, answersTurn: row.turnSeq,
      text: '[dash] The owner chose (via Telegram): 1. Should I proceed? → B ("rebuild it").' }]);
    await apiSettled(() => f.bot.count("editMessageText") === 1, "restored alert edit");
  });
});

describe("Telegram decision cards", () => {
  type F = Awaited<ReturnType<typeof pairedFixture>>;
  const base = { host: "synthetic-host", harness: "claude" as const, interactive: true };
  const single = "Which approach should we take?\nA. use the cache\nB. rebuild the index (recommended)";
  const multi = "Two calls to make.\n\n1. **Master direction:** which plan?\n   A. keep the current plan\n   B. use the alternate plan (recommended)\n" +
    "2. **Storage:** which store?\n   A. postgres\n   B. sqlite\n   C. files";
  const prose = "Should the cache use postgres or sqlite? Both work; sqlite is simpler and I'd go with sqlite.";
  const luna = { decisions: [{ title: "Should the cache use postgres or sqlite", options: [{ key: "A", label: "postgres" }, { key: "B", label: "sqlite" }],
    recIndex: 1, recQuote: "I'd go with sqlite" }] };
  const respond = (f: F, sessionId: string, text: string, cwd?: string) => {
    f.telegram.observe(f.db.applyEvent({ ...base, sessionId, cwd, kind: "prompt", ts: ++f.clock.now, text: "Synthetic prompt" }), "prompt");
    const row = f.db.applyEvent({ ...base, sessionId, cwd, kind: "response", ts: ++f.clock.now, text });
    f.telegram.observe(row, "response");
    return row;
  };
  const settleLuna = (f: F, row: SessionDTO, raw: unknown, state: "luna" | "none" | "failed" = "luna") => {
    const response = f.db.responseForTurn(row.key, row.turnSeq)!;
    expect(response.decisionState).toBe("pending");
    f.db.setDecisionsIfPending(response.id, validateDecisionSet(raw, response.text, "luna"), state);
    f.telegram.observeDecisions(f.db.getSession(row.key)!, response.id);
  };
  const tap = (f: F, data: string, messageId: number, overrides: Record<string, any> = {}) => f.bot.enqueueUpdate({ callback_query: {
    id: `cb-${f.bot.calls.length}`, from: { id: owner }, message: { message_id: messageId, chat: { id: chat, type: "private" } }, data, ...overrides } });
  const groupTap = (f: F, data: string, messageId: number) => tap(f, data, messageId, { message: { message_id: messageId, chat: { id: group, type: "supergroup" } } });
  const answers = (f: F) => f.bot.calls.filter(call => call.method === "answerCallbackQuery").map(call => call.body.text);
  const replyRows = (f: F) => (f.db.sqlite.query("SELECT COUNT(*) AS n FROM replies").get() as { n: number }).n;
  const edits = (f: F, method = "editMessageText") => f.bot.calls.filter(call => call.method === method).map(call => call.body);
  const settle = async (f: F) => {
    const offset = Number(f.db.getSetting("telegram.offset") ?? 0) + 1;
    f.bot.enqueue(message("ignored", { message_id: 900 + offset, from: { id: owner + 1 } }));
    await eventually(() => Number(f.db.getSetting("telegram.offset")) >= offset, "processed updates");
  };
  const button = (text: string, data: string) => ({ text, callback_data: data });
  const fixed = (id: string) => [[button(CONTINUE_LABEL, `d:${id}:99:3`)],
    [button("📄 Full text", `d:${id}:99:4`), button("🔕 Mute 1h", `d:${id}:99:5`)]];
  const singleKeyboard = (id: string, rec = " ⭐", labels = ["use the cache", "rebuild the index"]) =>
    [[button(labels[0]!, `d:${id}:0:0`), button(`${labels[1]}${rec}`, `d:${id}:0:1`)], ...fixed(id)];
  const multiKeyboard = (id: string, b = "1: B⭐") => [[button("1: A", `d:${id}:0:0`), button(b, `d:${id}:0:1`)],
    [button("2: A", `d:${id}:1:0`), button("2: B", `d:${id}:1:1`), button("2: C", `d:${id}:1:2`)],
    [button("✅ Send picks", `d:${id}:99:0`)], ...fixed(id)];
  const decisionsOn = { repliesEnabled: true, decisionsEnabled: true, ttlMs: 600_000 };

  test("a parser card replaces the turn alert in input and turns mode with the exact body and keyboard", async () => {
    for (const mode of ["input", "turns"] as const) {
      const f = await pairedFixture({ ...decisionsOn, mode });
      const row = respond(f, "single", single);
      await apiSettled(() => f.bot.sent.length === 1);
      await settle(f);
      expect(f.bot.sent).toHaveLength(1);
      expect(f.bot.sent[0].text).toBe([
        "❓ <b>single</b> · synthetic-host · claude",
        "<i>Decision · unknown</i>",
        "⭐ <b>Recommended:</b> Which approach should we take? → B (rebuild the index)",
        "1. <b>Which approach should we take?</b>",
        "   A · use the cache",
        "   B · rebuild the index ⭐",
      ].join("\n"));
      expect(f.bot.sent[0].reply_markup.inline_keyboard).toEqual(singleKeyboard("1"));
      expect(f.db.cardForTurn(row.key, row.turnSeq)).toMatchObject({ id: 1, state: "active", chatId: String(chat), messageId: 1 });
      expect(f.db.alertFor(String(chat), 1)).toEqual({ sessionKey: row.key, kind: "alert" });
    }
  });

  test("single-question buttons show the supplied Yes/No choices and submit the selected answer", async () => {
    const f = await pairedFixture(decisionsOn);
    const row = respond(f, "binary", "Should I proceed?\nA. Yes (Recommended)\nB. No");
    await apiSettled(() => f.bot.sent.length === 1);
    const options = f.bot.sent[0].reply_markup.inline_keyboard[0];
    expect(options.map((option: { text: string }) => option.text)).toEqual(["Yes ⭐", "No"]);
    tap(f, options[1].callback_data, 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(f.db.queuedReplies().map(reply => [reply.text, reply.answersTurn])).toEqual([
      ['[dash] The owner chose (via Telegram): 1. Should I proceed? → B ("No").', row.turnSeq],
    ]);
  });

  test("a multi-decision card matches the literal body and keyboard", async () => {
    const f = await pairedFixture(decisionsOn);
    respond(f, "multi", multi);
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent[0].text).toBe([
      "❓ <b>multi</b> · synthetic-host · claude",
      "<i>Decision · unknown</i>",
      "⭐ <b>Recommended:</b> Master direction → B (use the alternate plan)",
      "1. <b>Master direction</b>",
      "   A · keep the current plan",
      "   B · use the alternate plan ⭐",
      "2. <b>Storage</b>",
      "   A · postgres",
      "   B · sqlite",
      "   C · files",
    ].join("\n"));
    expect(f.bot.sent[0].reply_markup.inline_keyboard).toEqual(multiKeyboard("1"));
  });

  test("cards never send in off mode or while muted, and three cards never become a digest", async () => {
    const off = await pairedFixture({ ...decisionsOn, mode: "off" });
    respond(off, "off", single);
    await settle(off);
    expect(off.bot.sent).toHaveLength(0);
    const muted = await pairedFixture(decisionsOn);
    muted.db.setSetting("telegram.mute_until", String(muted.clock.now + 60_000));
    respond(muted, "muted", single);
    await settle(muted);
    expect(muted.bot.sent).toHaveLength(0);
    expect(muted.db.sqlite.query("SELECT COUNT(*) AS n FROM tg_cards").get()).toEqual({ n: 0 });
    const f = await pairedFixture(decisionsOn);
    for (const name of ["one", "two", "three"]) respond(f, name, single);
    await apiSettled(() => f.bot.sent.length === 3);
    await settle(f);
    expect(f.bot.sent).toHaveLength(3);
    expect(f.bot.sent.map(send => send.text.split("\n")[0])).toEqual(["one", "two", "three"].map(name => `❓ <b>${name}</b> · synthetic-host · claude`));
    expect(f.bot.sent.map(send => send.reply_markup.inline_keyboard[0][0].callback_data)).toEqual(["d:1:0:0", "d:2:0:0", "d:3:0:0"]);
  });

  test("a card goes to the project topic and a topic failure persists the General fallback", async () => {
    const f = await topicFixture(decisionsOn);
    const failed = { status: 400, body: { ok: false, error_code: 400, description: "synthetic failure text" } };
    const row = respond(f, "topic", single, "/projects/invest/synthetic");
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent[0]).toMatchObject({ chat_id: String(group), message_thread_id: 42 });
    expect(f.bot.sent[0].text).toContain("<i>Decision · invest</i>");
    expect(f.db.cardForTurn(row.key, row.turnSeq)).toMatchObject({ chatId: String(group), threadId: 42, messageId: 1, state: "active" });
    f.bot.sendSequence = [failed];
    const next = respond(f, "topic", single, "/projects/invest/synthetic");
    await apiSettled(() => f.bot.sent.length === 3 && f.db.cardForTurn(next.key, next.turnSeq)?.state === "active", "General card");
    expect(f.bot.sent[2]).toMatchObject({ chat_id: String(group) });
    expect(f.bot.sent[2].message_thread_id).toBeUndefined();
    expect(f.db.cardForTurn(next.key, next.turnSeq)).toMatchObject({ chatId: String(group), threadId: null, messageId: 3 });
  });

  test("a waiting liveness update while a card is active sends no generic alert", async () => {
    const f = await pairedFixture(decisionsOn);
    const row = respond(f, "waiting", single);
    await apiSettled(() => f.bot.sent.length === 1);
    f.clock.now += 11_000;
    const [waiting] = f.db.markLiveness("claude", [{ sessionId: "waiting", detail: "waiting" }], row.host, f.clock.now);
    expect(waiting).toMatchObject({ status: "needs_input", needsReason: "waiting" });
    f.telegram.observe(waiting!);
    await settle(f);
    expect(f.bot.sent).toHaveLength(1);
  });

  test("Luna edits the turn's alert into a card in place, in turns and input mode", async () => {
    for (const mode of ["turns", "input"] as const) {
      const f = await pairedFixture({ ...decisionsOn, judgeEnabled: true, mode });
      const row = respond(f, "luna", prose);
      await apiSettled(() => f.bot.sent.length === 1);
      const card = f.db.cardForTurn(row.key, row.turnSeq)!;
      expect(f.bot.sent[0].reply_markup.inline_keyboard.flat()
        .some((button: { callback_data: string }) => button.callback_data.startsWith("d:"))).toBe(false);
      settleLuna(f, row, luna);
      await eventually(() => edits(f).length === 1, "card edit");
      await settle(f);
      expect(f.bot.sent).toHaveLength(1);
      expect(edits(f)).toEqual([{ chat_id: String(chat), message_id: 1, parse_mode: "HTML", disable_web_page_preview: true,
        reply_markup: { inline_keyboard: singleKeyboard("1", " ⭐", ["postgres", "sqlite"]) }, text: [
          "❓ <b>luna</b> · synthetic-host · claude",
          "<i>Decision · unknown</i>",
          "⭐ <b>Recommended:</b> Should the cache use postgres or sqlite → B (sqlite)",
          "1. <b>Should the cache use postgres or sqlite</b>",
          "   A · postgres",
          "   B · sqlite ⭐",
        ].join("\n") }]);
      expect(f.db.cardForTurn(row.key, row.turnSeq)).toMatchObject({ id: card.id, state: "active", messageId: 1 });
      tap(f, "d:1:0:0", 1);
      await eventually(() => f.bot.count("answerCallbackQuery") === 1);
      expect(f.db.queuedReplies().map(reply => [reply.text, reply.answersTurn])).toEqual([
        ['[dash] The owner chose (via Telegram): 1. Should the cache use postgres or sqlite → A ("postgres").', row.turnSeq]]);
    }
  });

  test("Luna settling mid-batch edits the turn's card whether its alert is already sent or still in flight", async () => {
    for (const first of ["luna", "plain"] as const) {
      const clock = { now: 1_000_000 }, waits: Array<() => void> = [];
      const f = await pairedFixture({ ...decisionsOn, judgeEnabled: true, mode: "turns", clock,
        sleep: ms => new Promise<void>(resolve => waits.push(() => { clock.now += ms; resolve(); })) });
      // Both turns land in one drain batch, so the second send waits for the one-second slot.
      const rows = first === "luna" ? [respond(f, "luna", prose), respond(f, "plain", "Synthetic follow-up: done.")]
        : [respond(f, "plain", "Synthetic follow-up: done."), respond(f, "luna", prose)];
      const row = rows.find(dto => dto.displayName === "luna")!;
      await apiSettled(() => f.bot.sent.length === 1 && waits.length === 1, "paced second alert");
      expect(f.db.cardForTurn(row.key, row.turnSeq)!.state).toBe(first === "luna" ? "active" : "pending");
      settleLuna(f, row, luna);
      await eventually(() => { waits.splice(0).forEach(release => release()); return f.bot.sent.length === 2 && edits(f).length === 1; }, "card edit");
      const card = f.db.cardForTurn(row.key, row.turnSeq)!;
      expect(edits(f)[0]).toMatchObject({ message_id: card.messageId, reply_markup: { inline_keyboard: singleKeyboard(card.id.toString(36), " ⭐", ["postgres", "sqlite"]) } });
      expect(edits(f)[0].text).toStartWith("❓ <b>luna</b> · synthetic-host · claude\n<i>Decision · unknown</i>");
    }
  });

  test("a card stranded by a shutdown does not block the card a resumed Luna result sends for that turn", async () => {
    const db = new DashDB(":memory:", { decisionsEnabled: true, judgeEnabled: true });
    db.applyEvent({ ...base, sessionId: "resumed", kind: "prompt", ts: 998_000, text: "Synthetic prompt" });
    const row = db.applyEvent({ ...base, sessionId: "resumed", kind: "response", ts: 999_000, text: prose });
    const stranded = db.createCardIntent(row.key, row.lastResponses[0]!.id, row.turnSeq, { chatId: String(chat), threadId: null }, 900_000);
    if (stranded === "card_id_overflow") throw new Error("overflow");
    const f = await pairedFixture({ ...decisionsOn, judgeEnabled: true, db });
    expect(f.db.getCard(stranded.card.id)!.state).toBe("failed");
    settleLuna(f, row, luna);
    await apiSettled(() => f.bot.sent.length === 1, "resumed card");
    const card = f.db.cardForTurn(row.key, row.turnSeq)!;
    expect(card).toMatchObject({ state: "active", messageId: 1 });
    expect(card.id).not.toBe(stranded.card.id);
    expect(f.bot.sent[0].reply_markup.inline_keyboard).toEqual(singleKeyboard(card.id.toString(36), " ⭐", ["postgres", "sqlite"]));
  });

  test("input mode sends a card for a question, a blank line and a lettered list", async () => {
    const f = await pairedFixture(decisionsOn);
    respond(f, "lettered", "How do you want to handle the stale branch?\n\nA. Delete it\nB. Keep it for now");
    await apiSettled(() => f.bot.sent.length === 1);
    expect(f.bot.sent[0].text).toContain("1. <b>How do you want to handle the stale branch?</b>");
    expect(f.bot.sent[0].reply_markup.inline_keyboard).toEqual(singleKeyboard("1", "", ["Delete it", "Keep it for now"]));
  });

  test("a new card after Luna obeys off, mute, harness and turn gates, and goes out in input mode once unmuted", async () => {
    const off = await pairedFixture({ ...decisionsOn, judgeEnabled: true, mode: "off" });
    settleLuna(off, respond(off, "off", prose), luna);
    await settle(off);
    expect(off.bot.sent).toHaveLength(0);
    const f = await pairedFixture({ ...decisionsOn, judgeEnabled: true, mode: "input" });
    f.db.setSetting("telegram.mute_until", String(f.clock.now + 60_000));
    const muted = respond(f, "muted", prose), later = respond(f, "later", prose);
    settleLuna(f, muted, luna);
    await settle(f);
    expect(f.bot.sent).toHaveLength(0);
    f.clock.now += 60_000;
    settleLuna(f, later, luna);
    await apiSettled(() => f.bot.sent.length === 1, "unmuted card");
    expect(f.bot.sent[0].text).toStartWith("❓ <b>later</b> · synthetic-host · claude\n<i>Decision · unknown</i>");
    const t = await pairedFixture({ ...decisionsOn, judgeEnabled: true, mode: "turns" });
    const headless = t.db.applyEvent({ ...base, interactive: false, sessionId: "headless", kind: "response", ts: ++t.clock.now, text: prose });
    settleLuna(t, headless, luna);
    const busy = t.db.applyEvent({ ...base, sessionId: "busy", kind: "response", ts: ++t.clock.now, text: prose });
    t.db.applyEvent({ ...base, sessionId: "busy", kind: "prompt", ts: ++t.clock.now, text: "Synthetic prompt" });
    expect(t.db.getSession(busy.key)).toMatchObject({ status: "working", turnSeq: busy.turnSeq });
    settleLuna(t, busy, luna);
    await settle(t);
    expect(t.bot.sent).toHaveLength(0);
  });

  test("Luna none or failure leaves the ordinary alert unchanged; a moved turn gets no late card", async () => {
    for (const state of ["none", "failed"] as const) {
      const f = await pairedFixture({ ...decisionsOn, judgeEnabled: true, mode: "turns" });
      const row = respond(f, "plain", prose);
      await apiSettled(() => f.bot.sent.length === 1);
      settleLuna(f, row, { decisions: [] }, state);
      await settle(f);
      expect([f.bot.sent.length, edits(f).length]).toEqual([1, 0]);
      expect(f.db.cardForTurn(row.key, row.turnSeq)!.state).toBe("active");
    }
    const f = await pairedFixture({ ...decisionsOn, judgeEnabled: true, mode: "turns" });
    const row = respond(f, "moved", prose);
    await apiSettled(() => f.bot.sent.length === 1);
    f.db.applyEvent({ ...base, sessionId: "moved", kind: "response", ts: ++f.clock.now, text: "Synthetic follow-up: done." });
    settleLuna(f, row, luna);
    await settle(f);
    expect([f.bot.sent.length, edits(f).length]).toEqual([1, 0]);
  });

  test("with no alert for the turn, Luna sends a new card; retired taps before Luna queue nothing", async () => {
    const f = await pairedFixture({ ...decisionsOn, judgeEnabled: true, mode: "turns" });
    // No prompt was observed, so turns mode sees no working → your_turn edge and sends nothing yet.
    const row = f.db.applyEvent({ ...base, sessionId: "late", kind: "response", ts: ++f.clock.now, text: prose });
    f.telegram.observe(row, "response");
    await settle(f);
    expect(f.bot.sent).toHaveLength(0);
    settleLuna(f, row, luna);
    await apiSettled(() => f.bot.sent.length === 1, "new card");
    expect(f.bot.sent[0].reply_markup.inline_keyboard).toEqual(singleKeyboard("1", " ⭐", ["postgres", "sqlite"]));
    expect(f.bot.sent[0].text).toStartWith("❓ <b>late</b> · synthetic-host · claude\n<i>Decision · unknown</i>");

    const early = await pairedFixture({ ...decisionsOn, judgeEnabled: true, mode: "turns" });
    const asked = respond(early, "early", prose);
    await apiSettled(() => early.bot.sent.length === 1);
    tap(early, "d:1:99:2", 1);
    await eventually(() => early.bot.count("answerCallbackQuery") === 1);
    settleLuna(early, asked, luna);
    await settle(early);
    expect(early.db.queuedReplies()).toEqual([]);
    expect(edits(early)).toHaveLength(1);
    expect(edits(early)[0].reply_markup.inline_keyboard).toEqual(singleKeyboard("1", " ⭐", ["postgres", "sqlite"]));
    expect(early.bot.sent).toHaveLength(1);
  });

  test("card content is escaped, labels display at 60 and an oversized card stays under 4096", async () => {
    const f = await pairedFixture(decisionsOn);
    const long = `keep ${"wide ".repeat(30)}end`;
    respond(f, "escape", `Which <img src=x onerror=alert(1)> approach?\nA. ${long}\nB. use <b>bold</b> & more`);
    const big = "Eight calls.\n\n" + Array.from({ length: 9 }, (_, n) => `${n + 1}. Which <img src=x onerror=alert(1)> plan for area ${n + 1} ${"& wide ".repeat(14)}?\n` +
      Array.from({ length: 9 }, (_, k) => `   ${"abcdefghi"[k]}) choice ${k + 1} of ${n + 1} ${"<&> long ".repeat(15)}`).join("\n")).join("\n");
    respond(f, "huge", big);
    await apiSettled(() => f.bot.sent.length === 2);
    const [escaped, huge] = f.bot.sent;
    expect(escaped.text).toContain("1. <b>Which &lt;img src=x onerror=alert(1)&gt; approach?</b>");
    expect(escaped.text).toContain("   B · use &lt;b&gt;bold&lt;/b&gt; &amp; more");
    const shown = visibleText(escaped.text).split("\n").find(line => line.startsWith("   A · "))!.slice(7);
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(shown).toStartWith("keep wide");
    expect(shown).toEndWith("…");
    expect(huge.text.length).toBeLessThanOrEqual(4096);
    expect(huge.text).not.toContain("<img");
    expect(huge.text.match(/^\d\. <b>/gm)).toHaveLength(8);
    expect(huge.reply_markup.inline_keyboard).toHaveLength(11);
    expect(huge.reply_markup.inline_keyboard.slice(0, 8).every((row: unknown[]) => row.length === 8)).toBe(true);
    tap(f, "d:1:0:0", 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(f.db.queuedReplies()[0].text).toBe(`[dash] The owner chose (via Telegram): 1. Which <img src=x onerror=alert(1)> approach? → A ("${long}").`);
  });

  test("R3/R5: a duplicate response's new turn gets a new card id and the prior card goes stale", async () => {
    const f = await pairedFixture(decisionsOn);
    const first = respond(f, "repeat", single);
    await apiSettled(() => f.bot.sent.length === 1);
    const second = respond(f, "repeat", single);
    expect(second.turnSeq).toBe(first.turnSeq + 1);
    expect(f.db.countResponses()).toBe(1);
    await apiSettled(() => f.bot.sent.length === 2, "second card");
    const [old, fresh] = [f.db.cardForTurn(first.key, first.turnSeq)!, f.db.cardForTurn(second.key, second.turnSeq)!];
    expect([old.id, old.state, fresh.id, fresh.state, fresh.messageId]).toEqual([1, "stale", 2, "active", 2]);
    expect(f.bot.sent[1].reply_markup.inline_keyboard).toEqual(singleKeyboard("2"));
    tap(f, "d:1:0:1", 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(answers(f)).toEqual(["Expired, use /status"]);
    expect(replyRows(f)).toBe(0);
    tap(f, "d:2:0:1", 2);
    await eventually(() => f.bot.count("answerCallbackQuery") === 2);
    expect(f.db.queuedReplies().map(reply => reply.answersTurn)).toEqual([second.turnSeq]);
  });

  test("a label cut by the 160 code-point cap never shows a partial secret", async () => {
    const f = await pairedFixture(decisionsOn);
    const token = "abcd1234".repeat(7);
    respond(f, "capped", `Which deploy path?\nA. ${"word ".repeat(26)}${token} now (my pick)\nB. wait`);
    await apiSettled(() => f.bot.sent.length === 1);
    const label = f.db.cardForTurn(`synthetic-host|claude|capped`, 1)!.decisions.decisions[0]!.options[0]!.label;
    expect([...label]).toHaveLength(160);
    const text = visibleText(f.bot.sent[0].text);
    expect(text).toContain("⭐ Recommended: Which deploy path? → A (word");
    expect(text).not.toContain("abcd1234");
  });

  test("a single-decision option tap queues one exact reply and marks the card Sent", async () => {
    const f = await pairedFixture(decisionsOn);
    const row = respond(f, "single", single);
    await apiSettled(() => f.bot.sent.length === 1);
    for (const data of ["d:1:99:0", "d:1:99:1", "d:1:0:2", "d:1:1:0"]) tap(f, data, 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 4);
    expect(new Set(answers(f))).toEqual(new Set(["Expired, use /status"]));
    tap(f, "d:1:0:0", 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 5);
    expect(f.db.queuedReplies()).toMatchObject([{ sessionKey: row.key, source: "telegram", actor: `telegram:${owner}`, answersTurn: row.turnSeq,
      text: '[dash] The owner chose (via Telegram): 1. Which approach should we take? → A ("use the cache").' }]);
    expect(answers(f).at(-1)).toBe("Sent to single");
    await eventually(() => edits(f).length === 1 && edits(f, "editMessageReplyMarkup").length === 1, "card edits");
    expect(edits(f, "editMessageReplyMarkup")[0]).toEqual({ chat_id: String(chat), message_id: 1, reply_markup: { inline_keyboard: [] } });
    expect(edits(f)[0].text).toEndWith("   B · rebuild the index ⭐\n\n✅ Sent: 1: A");
    expect(edits(f)[0].reply_markup).toBeUndefined();
  });

  test("options E and F on a card submit or toggle the option, never Full text or Mute", async () => {
    const six = "Which region should we deploy to?\nA. us-east\nB. us-west\nC. eu-west\nD. eu-central\nE. ap-south\nF. ap-east";
    const f = await pairedFixture(decisionsOn);
    const row = respond(f, "six", six);
    await apiSettled(() => f.bot.sent.length === 1);
    tap(f, "d:1:0:5", 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    expect(answers(f)).toEqual(["Sent to six"]);
    expect(f.db.queuedReplies()).toMatchObject([{ sessionKey: row.key, answersTurn: row.turnSeq,
      text: '[dash] The owner chose (via Telegram): 1. Which region should we deploy to? → F ("ap-east").' }]);
    expect(f.bot.sent.length).toBe(1);
    const multiSix = "Two calls.\n\n1. **Region:** which one?\n   A. us-east\n   B. us-west\n   C. eu-west\n   D. eu-central\n   E. ap-south\n" +
      "2. **Store:** which store?\n   A. postgres\n   B. sqlite";
    const g = await pairedFixture(decisionsOn);
    respond(g, "multisix", multiSix);
    await apiSettled(() => g.bot.sent.length === 1);
    tap(g, "d:1:0:4", 1);
    await eventually(() => g.bot.count("answerCallbackQuery") === 1);
    expect(answers(g)).toEqual(["Picked 1: E"]);
    expect(g.db.getCard(1)!.picks).toEqual({ "0": 4 });
    expect(g.bot.sent.length).toBe(1);
  });

  test("multi-decision picks toggle, Send picks falls back to rec then your call, retired actions cannot bypass picks", async () => {
    const f = await pairedFixture(decisionsOn);
    const row = respond(f, "multi", multi);
    await apiSettled(() => f.bot.sent.length === 1);
    tap(f, "d:1:0:1", 1);
    await eventually(() => edits(f, "editMessageReplyMarkup").length === 1);
    expect(f.db.getCard(1)!.picks).toEqual({ "0": 1 });
    expect(edits(f, "editMessageReplyMarkup")[0]).toEqual({ chat_id: String(chat), message_id: 1, reply_markup: { inline_keyboard: multiKeyboard("1", "1: B✓⭐") } });
    tap(f, "d:1:0:1", 1);
    await eventually(() => edits(f, "editMessageReplyMarkup").length === 2);
    expect(f.db.getCard(1)!.picks).toEqual({});
    expect(edits(f, "editMessageReplyMarkup")[1].reply_markup.inline_keyboard).toEqual(multiKeyboard("1"));
    tap(f, "d:1:1:2", 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 3);
    expect(answers(f)).toEqual(["Picked 1: B", "Cleared 1: B", "Picked 2: C"]);
    expect(replyRows(f)).toBe(0);
    tap(f, "d:1:99:0", 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 4);
    expect(f.db.queuedReplies().map(reply => [reply.text, reply.answersTurn])).toEqual([['[dash] The owner chose (via Telegram): ' +
      '1. Master direction → your recommendation ("use the alternate plan"). 2. Storage → C ("files").', row.turnSeq]]);
    await eventually(() => edits(f).length === 1);
    expect(visibleText(edits(f)[0].text)).toEndWith("✅ Sent: 1: B⭐, 2: C");

    const recs = await pairedFixture(decisionsOn);
    respond(recs, "recs", multi);
    await apiSettled(() => recs.bot.sent.length === 1);
    tap(recs, "d:1:1:0", 1);
    await eventually(() => recs.bot.count("answerCallbackQuery") === 1);
    for (const option of [1, 2]) tap(recs, `d:1:99:${option}`, 1);
    await eventually(() => recs.bot.count("answerCallbackQuery") === 3);
    expect(recs.db.queuedReplies()).toEqual([]);
    expect(recs.db.getCard(1)).toMatchObject({ state: "active", picks: { "1": 0 } });
  });

  test("a replayed Send yields one reply and a moved turn refuses options and toggles", async () => {
    const f = await pairedFixture(decisionsOn);
    respond(f, "replay", multi);
    await apiSettled(() => f.bot.sent.length === 1);
    for (let i = 0; i < 3; i++) tap(f, "d:1:99:0", 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 3);
    expect(replyRows(f)).toBe(1);
    expect(answers(f)).toEqual(["Sent to replay", "Expired, use /status", "Expired, use /status"]);

    const moved = await pairedFixture(decisionsOn);
    const rows = [respond(moved, "moved-one", single), respond(moved, "moved-two", multi)];
    await apiSettled(() => moved.bot.sent.length === 2);
    for (const row of rows) moved.db.applyEvent({ ...base, sessionId: row.sessionId, kind: "response", ts: ++moved.clock.now, text: "Synthetic follow-up: done." });
    tap(moved, "d:1:0:0", 1);
    tap(moved, "d:2:0:1", 2);
    await eventually(() => moved.bot.count("answerCallbackQuery") === 2 && edits(moved, "editMessageReplyMarkup").length === 2);
    expect(answers(moved)).toEqual(["Out of date: the session has moved on", "Out of date: the session has moved on"]);
    expect(edits(moved, "editMessageReplyMarkup").map(body => [body.message_id, body.reply_markup])).toEqual([[1, { inline_keyboard: [] }], [2, { inline_keyboard: [] }]]);
    expect([moved.db.getCard(1)!.state, moved.db.getCard(2)!.state, moved.db.getCard(2)!.picks]).toEqual(["stale", "stale", {}]);
    expect(replyRows(moved)).toBe(0);
  });

  test("an option tap a waiting Claude hook takes at once ends at Delivered, never a late Sent", async () => {
    const f = await pairedFixture(decisionsOn);
    const row = respond(f, "instant", single);
    await apiSettled(() => f.bot.sent.length === 1);
    const pending = f.replies!.waitClaude(row.key, "waiteraaaaaaaaaa", 1, 5_000);
    tap(f, "d:1:0:1", 1);
    const delivered = await pending;
    expect(JSON.stringify(delivered)).toContain("1. Which approach should we take? → B (\\\"rebuild the index\\\").");
    await eventually(() => edits(f).length >= 1 && edits(f, "editMessageReplyMarkup").length === 1, "card edits");
    await settle(f);
    const texts = edits(f).map(body => visibleText(body.text));
    expect(texts.at(-1)).toMatch(/✅ Delivered$/);
    expect(texts.some(text => text.includes("✅ Sent"))).toBe(false);
  });

  test("Full text is redacted, escaped, ordered and chunked; Mute lasts exactly one hour; neither queues", async () => {
    const f = await pairedFixture(decisionsOn);
    const secret = `sk-${"c".repeat(30)}`;
    const text = `${single}\n\n${Array.from({ length: 300 }, (_, i) => `Line ${i} has <tags> & ${i === 150 ? secret : "words"}.`).join("\n\n")}`;
    respond(f, "full", text);
    await apiSettled(() => f.bot.sent.length === 1);
    tap(f, "d:1:99:4", 1);
    await apiSettled(() => f.bot.sent.length >= 3 && f.bot.count("answerCallbackQuery") === 1, "full text chunks");
    await settle(f);
    const chunks = f.bot.sent.slice(1).map(send => send.text as string);
    expect(chunks.every(chunk => chunk.length <= 4096)).toBe(true);
    expect(chunks.map(chunk => /^<b>Full text · Part (\d+)\/(\d+)<\/b>/.exec(chunk)!.slice(1).map(Number)))
      .toEqual(chunks.map((_, i) => [i + 1, chunks.length]));
    const joined = chunks.map(visibleText).join("\n");
    expect(joined).not.toContain(secret);
    expect(joined).toContain("Line 150 has <tags> & [redacted].");
    expect(joined.indexOf("Line 299")).toBeGreaterThan(joined.indexOf("Line 0 "));
    expect(chunks.join("")).not.toContain("<tags>");
    expect(replyRows(f)).toBe(0);

    const start = f.clock.now;
    tap(f, "d:1:99:5", 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 2);
    expect(answers(f).at(-1)).toBe("Muted full for 1h");
    const before = f.bot.sent.length;
    f.clock.now = start + 3_600_000 - 10;
    respond(f, "full", single);
    await settle(f);
    expect(f.bot.sent).toHaveLength(before);
    f.clock.now = start + 3_600_000;
    respond(f, "full", single);
    await apiSettled(() => f.bot.sent.length === before + 1, "card after mute");
    expect(replyRows(f)).toBe(0);
  });

  test("a card reply-to stays free text in its own chat and outcome edits use the saved card message after unbind", async () => {
    const f = await topicFixture(decisionsOn);
    const row = respond(f, "routed", single, "/projects/invest/synthetic");
    await apiSettled(() => f.bot.sent.length === 1);
    f.bot.enqueue(message("free text from dm", { message_id: 31, reply_to_message: { message_id: 1 } }));
    f.bot.enqueue(groupMessage("free text from topic", 42, { message_id: 32, reply_to_message: { message_id: 1 } }));
    await apiSettled(() => f.bot.sent.length === 2);
    expect(f.bot.sent.every(body => body.chat_id === String(group))).toBe(true);
    expect(f.db.queuedReplies().map(reply => [reply.sessionKey, reply.text, reply.answersTurn ?? null])).toEqual([[row.key, "free text from topic", null]]);
    f.replies!.cancelAll();
    const next = respond(f, "routed", single, "/projects/invest/synthetic");
    await eventually(() => f.db.cardForTurn(next.key, next.turnSeq)?.state === "active");
    const card = f.db.cardForTurn(next.key, next.turnSeq)!;
    groupTap(f, `d:${card.id.toString(36)}:0:0`, card.messageId!);
    await eventually(() => f.db.getCard(card.id)!.state === "sent");
    // The Sent edit and a later outcome coalesce into one edit when both land before it runs, so wait for Sent first.
    await apiSettled(() => edits(f).some(body => body.message_id === card.messageId && /✅ Sent: /.test(visibleText(body.text))), "sent card edit");
    f.db.setSetting("telegram.topics", JSON.stringify({ groupChatId: String(group), topics: { general: null } }));
    f.replies!.cancelAll();
    await eventually(() => edits(f).some(body => body.message_id === card.messageId && visibleText(body.text).endsWith("✖️ Cancelled")), "cancelled card");
    expect(edits(f).filter(body => body.message_id === card.messageId).map(body => body.chat_id)).toEqual([String(group), String(group)]);
  });

  test("a card's picks survive a restart and Send picks still submits them", async () => {
    const f = await pairedFixture(decisionsOn);
    respond(f, "restart", multi);
    await apiSettled(() => f.bot.sent.length === 1);
    tap(f, "d:1:1:1", 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1);
    f.telegram.close();
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => f.clock.now, replies: f.replies,
      readToken: async () => token, sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok");
    tap(f, "d:1:99:0", 1);
    await eventually(() => f.bot.count("answerCallbackQuery") === 2);
    expect(f.db.queuedReplies().map(reply => reply.text)).toEqual(['[dash] The owner chose (via Telegram): ' +
      '1. Master direction → your recommendation ("use the alternate plan"). 2. Storage → B ("sqlite").']);
    await eventually(() => edits(f).length === 1, "restored card edit");
    expect(visibleText(edits(f)[0].text)).toEndWith("✅ Sent: 1: B⭐, 2: B");
  });

  test("the server routes a Luna result to an in-place card edit with fake codex and a fake Bot API", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "dash-cards-"));
    writeFileSync(join(scratch, "out.json"), JSON.stringify(luna));
    writeFileSync(join(scratch, "codex"), `#!/bin/sh\ncat > /dev/null\nout=""; prev=""\nfor a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done\ncp '${scratch}/out.json' "$out"\n`);
    chmodSync(join(scratch, "codex"), 0o755);
    const dataPath = join(scratch, "dash.sqlite"), seeded = new DashDB(dataPath);
    seeded.setSetting("telegram.chat_id", String(chat));
    seeded.setSetting("telegram.user_id", String(owner));
    seeded.close();
    const bot = new FakeBot();
    const names = ["DASH_TELEGRAM", "DASH_REPLIES", "DASH_JUDGE", "DASH_TG_TOPICS", "DASH_TELEGRAM_SNIPPET_CHARS"];
    const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
    Object.assign(process.env, { DASH_TELEGRAM: "1", DASH_REPLIES: "1", DASH_JUDGE: "1", DASH_TG_TOPICS: "" });
    delete process.env.DASH_TELEGRAM_SNIPPET_CHARS;
    const app = createDashServer({ port: 0, dataPath, backfill: false, liveness: false, judge: { bin: join(scratch, "codex"), dataDir: scratch },
      telegram: { apiBase: bot.base, readToken: async () => token, sleep: async ms => Bun.sleep(Math.min(ms, 10)) } });
    try {
      await eventually(() => app.db.getSetting("telegram.chat_id") === String(chat) && bot.count("getUpdates") > 0, "server poller");
      await fetch(`http://127.0.0.1:${app.server.port}/ingest/claude`, { method: "POST", headers: { "Content-Type": "application/json",
        "X-Dash-Host": "synthetic-host", "X-Dash-Entrypoint": "cli", "X-Dash-Attended": "1" },
        body: JSON.stringify({ hook_event_name: "Stop", session_id: "e2e", cwd: "/synthetic/project", last_assistant_message: prose }) });
      await eventually(() => bot.count("editMessageText") === 1, "Luna card edit");
      expect(bot.sent).toHaveLength(1);
      expect(bot.sent[0].reply_markup.inline_keyboard.flat()
        .some((button: { callback_data: string }) => button.callback_data.startsWith("d:"))).toBe(false);
      const edit = bot.calls.find(call => call.method === "editMessageText")!.body;
      expect(edit).toMatchObject({ chat_id: String(chat), message_id: 1, reply_markup: { inline_keyboard: singleKeyboard("1", " ⭐", ["postgres", "sqlite"]) } });
      expect(edit.text).toContain("<i>Decision · project</i>");
    } finally {
      app.close(); bot.close();
      for (const name of names) if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name];
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("Telegram native question answers", () => {
  const tapQuestion = (f: Awaited<ReturnType<typeof pairedFixture>>, callbackId: string, questionId: string,
    questionIndex: number, action: string, messageId: number, chatId = chat, threadId?: number) =>
    f.bot.enqueueUpdate({ callback_query: {
      id: callbackId, from: { id: owner },
      message: { message_id: messageId, chat: { id: chatId, type: chatId === chat ? "private" : "supergroup" },
        ...(threadId === undefined ? {} : { message_thread_id: threadId }) },
      data: `q:${questionId}:${questionIndex}:${action}`,
    } });
  const questionMessages = (bot: FakeBot) =>
    bot.sent.filter(send => typeof send.text === "string" && send.text.includes("Claude / OMP question"));

  test("redacts every displayed question field before pagination", async () => {
    const f = await pairedFixture({ repliesEnabled: true, clock: { now: Date.now() } });
    const headerSecret = `sk-${"H".repeat(24)}`, questionSecret = `sk-${"Q".repeat(24)}`;
    const labelSecret = `sk-${"L".repeat(24)}`, descriptionSecret = `sk-${"D".repeat(24)}`;
    const previewSecret = `sk-${"P".repeat(24)}`;
    const { id } = registerClaudeQuestion(f, "redacted-question", [{
      id: "choice", header: `Header ${headerSecret}`, question: `${"q".repeat(535)}${questionSecret}`,
      options: [{ label: `Label ${labelSecret}`, description: `Description ${descriptionSecret}`, preview: `Preview ${previewSecret}` },
        { label: "Other choice" }],
    }]);
    await apiSettled(() => questionMessages(f.bot).length === 2, "redacted question pages");
    const rendered = questionMessages(f.bot).map(send => visibleText(send.text)).join("\n");
    for (const secret of [headerSecret, questionSecret, labelSecret, descriptionSecret, previewSecret]) {
      expect(rendered).not.toContain(secret);
    }
    expect(rendered.match(/\[redacted\]/g)).toHaveLength(5);
    expect(rendered).not.toContain(questionSecret.slice(0, 8));
    expect(rendered).not.toContain(questionSecret.slice(8));
    expect(f.db.telegramQuestionMessagesForQuestion(id)).toHaveLength(1);
  });

  test("zero content budget keeps native question details and answer controls off Telegram", async () => {
    const f = await pairedFixture({ repliesEnabled: true, snippetChars: 0, clock: { now: Date.now() } });
    const secret = `sk-${"Z".repeat(24)}`;
    const { id } = registerClaudeQuestion(f, "zero-question-content", [{
      id: "private-route", header: `Private header ${secret}`, question: `Should this be shown? ${secret}`,
      options: [{ label: `Use secure route (Recommended) ${secret}`, description: `Private detail ${secret}` },
        { label: "Fallback route", preview: `Private preview ${secret}` }],
    }]);
    await apiSettled(() => f.bot.sent.length > 0, "metadata-only needs-input alert");
    const rendered = visibleText(f.bot.sent.map(send => send.text).join("\n"));
    for (const hidden of ["Private header", "Should this be shown?", "Use secure route", "Private detail", "Private preview"]) {
      expect(rendered).not.toContain(hidden);
    }
    expect(questionMessages(f.bot)).toHaveLength(0);
    expect(f.db.telegramQuestionMessagesForQuestion(id)).toHaveLength(0);
    const buttons = f.bot.sent.flatMap(send => send.reply_markup?.inline_keyboard?.flat() ?? []);
    expect(buttons.some((button: { callback_data?: string }) => button.callback_data?.startsWith("q:"))).toBe(false);
  });

  test("positive budget clips one complete question before pagination and hides choices it cannot fit", async () => {
    const f = await pairedFixture({ repliesEnabled: true, snippetChars: 160, clock: { now: Date.now() } });
    registerClaudeQuestion(f, "bounded-question", [{
      id: "route", header: "Route selection", question: "Which path should be used?",
      options: [{ label: "Keep local", description: "No rewrite" },
        { label: "Use remote", preview: `Overflow sample ${"excerpt ".repeat(100)}UNSENT-OVERFLOW-TAIL` }],
    }]);
    await apiSettled(() => questionMessages(f.bot).length === 1, "bounded question card");
    const content = visibleText(questionMessages(f.bot)[0]!.text).split("\n").slice(1).join("\n");
    expect([...content].length).toBeLessThanOrEqual(160);
    expect(content).toContain("1. Keep local");
    expect(content).toContain("2. Use remote");
    expect(content).not.toContain("UNSENT-OVERFLOW-TAIL");

    const hidden = await pairedFixture({ repliesEnabled: true, snippetChars: 16, clock: { now: Date.now() } });
    const { id } = registerClaudeQuestion(hidden, "hidden-choice-question", [{
      id: "route", question: "Which path?", options: [{ label: "Keep local" }, { label: "Use remote" }],
    }]);
    await apiSettled(() => hidden.bot.sent.length > 0, "bounded metadata-only alert");
    expect(questionMessages(hidden.bot)).toHaveLength(0);
    expect(hidden.db.telegramQuestionMessagesForQuestion(id)).toHaveLength(0);
    const buttons = hidden.bot.sent.flatMap(send => send.reply_markup?.inline_keyboard?.flat() ?? []);
    expect(buttons.some((button: { callback_data?: string }) => button.callback_data?.startsWith("q:"))).toBe(false);
  });

  test.each(["question", "description", "redaction"] as const)(
    "repeated option text in %s cannot stand in for the actual option labels", async source => {
      const f = await pairedFixture({
        repliesEnabled: true, snippetChars: source === "redaction" ? Infinity : 100, clock: { now: Date.now() },
      });
      const keyType = "PRIVATE KEY";
      const beginKey = `-----BEGIN ${keyType}-----`, endKey = `-----END ${keyType}-----`;
      const { id } = registerClaudeQuestion(f, `repeated-label-${source}`, [{
        id: "route",
        question: source === "question"
          ? `Examples: 1. Keep, 2. Replace. ${"context ".repeat(40)}`
          : source === "redaction" ? `Examples: 1. Keep, 2. Replace ${endKey}.` : "Which route?",
        options: [
          { label: "Keep", description: source === "description"
            ? `Example: 2. Replace. ${"context ".repeat(40)}`
            : source === "redaction" ? `${beginKey}\nsynthetic-key-material` : undefined },
          { label: source === "redaction" ? `Replace ${endKey}` : "Replace" },
        ],
      }]);
      await apiSettled(() => f.bot.sent.length > 0, "metadata-only hidden-option alert");
      expect(questionMessages(f.bot)).toHaveLength(0);
      expect(f.db.telegramQuestionMessagesForQuestion(id)).toHaveLength(0);
      const buttons = f.bot.sent.flatMap(send => send.reply_markup?.inline_keyboard?.flat() ?? []);
      expect(buttons.some((button: { callback_data?: string }) => button.callback_data?.startsWith("q:"))).toBe(false);
    },
  );

  test.each(["global", "session"] as const)("does not create native question cards during a %s mute", async mute => {
    const f = await pairedFixture({ repliesEnabled: true, clock: { now: Date.now() } });
    const sessionId = `native-${mute}-mute`;
    if (mute === "global") f.db.setSetting("telegram.mute_until", String(f.clock.now + 60_000));
    else {
      const row = f.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId, kind: "question",
        ts: f.clock.now, text: "Synthetic waiting question", interactive: true });
      f.telegram.observe(row);
      await apiSettled(() => f.bot.sent.length === 1, "session alert with mute action");
      const data = f.bot.sent[0]!.reply_markup.inline_keyboard[0][0].callback_data;
      f.bot.enqueueUpdate({ callback_query: {
        id: "mute-native-question", from: { id: owner },
        message: { chat: { id: chat, type: "private" } }, data,
      } });
      await eventually(() => f.bot.count("answerCallbackQuery") === 1, "session mute callback");
    }
    const { id } = registerClaudeQuestion(f, sessionId, [{
      id: "choice", question: "Should this stay muted?", options: [{ label: "Yes" }, { label: "No" }],
    }]);
    await apiSettled(() => questionMessages(f.bot).length === 0);
    expect(questionMessages(f.bot)).toHaveLength(0);
    expect(f.db.telegramQuestionMessagesForQuestion(id)).toHaveLength(0);
  });

  test("a queued question send rechecks mute after pacing and replay does not resend it", async () => {
    const clock = { now: Date.now() };
    let holdNextSleep = false, releaseSleep: (() => void) | undefined, markSleepStarted: (() => void) | undefined;
    const sleepStarted = new Promise<void>(resolve => { markSleepStarted = resolve; });
    const sleep = async (ms: number) => {
      if (holdNextSleep) {
        holdNextSleep = false;
        await new Promise<void>(resolve => {
          releaseSleep = () => { clock.now += ms; resolve(); };
          markSleepStarted?.();
        });
      } else clock.now += ms;
    };
    const f = await topicFixture({ repliesEnabled: true, clock, sleep });
    const rateLimitRow = f.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "rate-limit",
      cwd: "/projects/invest/synthetic", kind: "question", ts: clock.now, text: "Synthetic waiting text", interactive: true });
    f.telegram.observe(rateLimitRow);
    await apiSettled(() => f.bot.sent.length === 1, "prior paced send");

    const { id, key } = registerClaudeQuestion(f, "queued-question", [{
      id: "choice", question: "Queued synthetic question?", options: [{ label: "First" }, { label: "Second" }],
    }], false);
    const row = f.db.getSession(key)!;
    f.db.setSetting("telegram.mute_until", String(clock.now + 60_000));
    f.telegram.observe(row, "question");
    f.db.setSetting("telegram.mute_until", "0");
    holdNextSleep = true;
    f.telegram.observe(row, "question");
    await sleepStarted;
    f.db.setSetting("telegram.mute_until", String(clock.now + 60_000));
    const marker = f.telegram.sendUrgent("invest", "Synthetic queue synchronization marker");
    releaseSleep!();
    expect(await marker).toBe(true);
    expect(questionMessages(f.bot)).toHaveLength(0);
    expect(f.db.telegramQuestionMessagesForQuestion(id)).toHaveLength(0);

    f.db.setSetting("telegram.mute_until", "0");
    f.telegram.observe(row, "question");
    await apiSettled(() => questionMessages(f.bot).length === 1, "unmuted question card");
    const beforeReplay = questionMessages(f.bot).length;
    f.db.setSetting("telegram.mute_until", String(clock.now + 60_000));
    f.telegram.close();
    const again = createTelegram({ db: f.db, apiBase: f.bot.base, fetch: trackedFetch, now: () => clock.now, replies: f.replies,
      readToken: async () => token, sleep: async ms => { clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok", "muted question replay startup");
    await apiSettled(() => questionMessages(f.bot).length === beforeReplay, "muted question replay");
    expect(questionMessages(f.bot)).toHaveLength(beforeReplay);
  });


  test.each([
    ["option", false], ["custom", false], ["option", true], ["custom", true],
  ] as const)("one single-choice %s answer sends once (group topics: %s)", async (kind, topics) => {
    const f = await (topics ? topicFixture : pairedFixture)({ repliesEnabled: true, clock: { now: Date.now() } });
    const recipient = topics ? group : chat;
    const { id, key, toolUseId } = registerClaudeQuestion(f, `single-${kind}`, [
      { id: "route", question: "Which route?", options: [{ label: "Local (Recommended)" }, { label: "Remote" }] },
    ]);
    const wait = f.replies!.waitQuestion(key, id, toolUseId, 30_000);
    await apiSettled(() => f.db.telegramQuestionMessagesForQuestion(id).some(item => !item.prompt), "single question card");
    const card = f.db.telegramQuestionMessagesForQuestion(id).find(item => !item.prompt)!;
    const answer = kind === "option" ? "Remote" : "café 雪 — custom";
    expect(card.chatId).toBe(String(recipient));
    tapQuestion(f, "single-answer", id, 0, kind === "option" ? "1" : "c", card.messageId, recipient);
    if (kind === "custom") {
      await apiSettled(() => f.db.telegramQuestionMessagesForQuestion(id).some(item => item.prompt), "custom reply prompt");
      const prompt = f.db.telegramQuestionMessagesForQuestion(id).find(item => item.prompt)!;
      expect(prompt.chatId).toBe(String(recipient));
      // Selective ForceReply targets mentions or the original message's sender.
      // This prompt replies to our own bot card, so it must mention the owner.
      const sentPrompt = f.bot.calls.filter(call => call.method === "sendMessage" && call.body.reply_markup?.force_reply).at(-1)!.body;
      expect(sentPrompt.reply_markup.selective).toBe(true);
      const replyTargets = [...String(sentPrompt.text).matchAll(/<a href="tg:\/\/user\?id=(\d+)">/g)].map(match => match[1]);
      expect(replyTargets).toEqual([String(owner)]);
      f.bot.enqueue(message(answer, { message_id: 99, chat: { id: recipient, type: topics ? "supergroup" : "private" },
        reply_to_message: { message_id: prompt.messageId } }));
    }
    expect(await wait).toEqual({ status: 200, answers: { "Which route?": answer } });
    expect(f.db.getQuestionInvocation(id, key)).toMatchObject({ state: "consumed", source: "telegram", listener: "telegram" });
    expect(f.db.telegramQuestionMessagesForQuestion(id)).toHaveLength(0);
    tapQuestion(f, "replayed-answer", id, 0, "0", card.messageId, recipient);
    await eventually(() => f.bot.count("answerCallbackQuery") === 2, "replayed answer refusal");
    expect(await f.replies!.waitQuestion(key, id, toolUseId, 1)).toEqual({ status: 409 });
    expect(f.bot.sent.every(send => send.chat_id === String(recipient))).toBe(true);
  });

  test("moves a pending private question into the group when topic mode is enabled", async () => {
    const f = await pairedFixture({ repliesEnabled: true, clock: { now: Date.now() } });
    const { id, key, toolUseId } = registerClaudeQuestion(f, "question-group-cutover", [
      { id: "route", question: "Which route?", options: [{ label: "Local" }, { label: "Remote" }] },
    ]);
    await apiSettled(() => f.db.telegramQuestionMessagesForQuestion(id).some(item => !item.prompt));
    const oldCard = f.db.telegramQuestionMessagesForQuestion(id).find(item => !item.prompt)!;
    f.telegram.close();
    f.db.setSetting("telegram.topics", JSON.stringify({ groupChatId: String(group), topics: defaultTopics }));
    const again = createTelegram({ db: f.db, topicsEnabled: true, replies: f.replies, apiBase: f.bot.base,
      fetch: trackedFetch, now: () => f.clock.now, readToken: async () => token,
      sleep: async ms => { f.clock.now += ms; } });
    resources.push(() => again.close());
    again.start();
    await eventually(() => again.health().state === "ok");
    expect(await again.sendUrgent("synthetic", "Group synchronization marker")).toBe(true);
    const cards = f.db.telegramQuestionMessagesForQuestion(id).filter(item => !item.prompt);
    expect(cards.map(card => card.chatId)).toEqual([String(group)]);
    expect(f.bot.calls.filter(call => call.method === "editMessageReplyMarkup" &&
      call.body.chat_id === String(chat) && call.body.message_id === oldCard.messageId)
      .at(-1)?.body.reply_markup.inline_keyboard).toEqual([]);
    tapQuestion(f, "group-cutover-answer", id, 0, "1", cards[0]!.messageId, group);
    expect(await f.replies!.waitQuestion(key, id, toolUseId, 30_000)).toEqual({
      status: 200, answers: { "Which route?": "Remote" },
    });
  });

  test("preserves multiple Claude selections and custom text, then consumes one exact answer map", async () => {
    const f = await pairedFixture({ repliesEnabled: true, clock: { now: Date.now() } });
    const originalQuestion = `Choose an approach? sk-${"Q".repeat(24)}`;
    const originalLabel = `Replace (Recommended) sk-${"O".repeat(24)}`;
    const questions: AskQuestion[] = [
      { id: "approach", question: originalQuestion, header: "Implementation",
        options: [{ label: "Keep <existing> & tested", description: "No rewrite" }, { label: originalLabel }] },
      { id: "colors", question: "Which colors?", options: [{ label: "Red & blue" }, { label: "Green" }], multi: true },
    ];
    const { id, key, toolUseId } = registerClaudeQuestion(f, "telegram-claude-question", questions);
    const wait = f.replies!.waitQuestion(key, id, toolUseId, 30_000);
    await apiSettled(() => f.db.telegramQuestionMessagesForQuestion(id).filter(item => !item.prompt).length === 2,
      "two question cards");
    const q0 = f.db.telegramQuestionMessagesForQuestion(id).find(item => !item.prompt && item.questionIndex === 0)!;
    const q1 = f.db.telegramQuestionMessagesForQuestion(id).find(item => !item.prompt && item.questionIndex === 1)!;
    expect(f.bot.sent.some(item => visibleText(item.text).includes("Keep <existing> & tested") &&
      visibleText(item.text).includes("Replace (Recommended)"))).toBe(true);

    tapQuestion(f, "select-single", id, 0, "1", q0.messageId);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1, "single selection");
    tapQuestion(f, "select-multi", id, 1, "0", q1.messageId);
    await eventually(() => f.bot.count("answerCallbackQuery") === 2, "first multi selection");
    tapQuestion(f, "select-multi-second", id, 1, "1", q1.messageId);
    await eventually(() => f.bot.count("answerCallbackQuery") === 3, "second multi selection");
    tapQuestion(f, "custom-button", id, 1, "c", q1.messageId);
    await eventually(() => f.bot.count("answerCallbackQuery") === 4, "custom-answer prompt");
    await apiSettled(() => f.db.telegramQuestionMessagesForQuestion(id).some(item => item.prompt), "ForceReply prompt");
    const prompt = f.db.telegramQuestionMessagesForQuestion(id).find(item => item.prompt)!;
    f.bot.enqueue(message("My own & free", { message_id: 99, reply_to_message: { message_id: prompt.messageId } }));
    await apiSettled(() => !f.db.telegramQuestionMessage(chat, prompt.messageId), "custom reply consumed");
    expect(f.db.getQuestionInvocation(id, key)?.state).toBe("pending");

    tapQuestion(f, "submit-answers", id, 1, "s", q1.messageId);
    await eventually(() => f.bot.count("answerCallbackQuery") === 5, "answer submission");
    expect(await wait).toEqual({
      status: 200,
      answers: {
        [originalQuestion]: originalLabel,
        "Which colors?": "Red & blue, Green, My own & free",
      },
    });
    expect(f.db.getQuestionInvocation(id, key)?.state).toBe("consumed");
    expect(f.db.telegramQuestionMessagesForQuestion(id)).toHaveLength(0);

    tapQuestion(f, "stale-question", id, 0, "0", q0.messageId);
    await eventually(() => f.bot.count("answerCallbackQuery") === 6, "stale button refusal");
    expect(f.db.getQuestionInvocation(id, key)?.state).toBe("consumed");
  });

  test("cancel returns Claude to its native terminal question without approving anything", async () => {
    const f = await pairedFixture({ repliesEnabled: true, clock: { now: Date.now() } });
    const { id, key, toolUseId } = registerClaudeQuestion(f, "telegram-terminal-fallback", [
      { id: "continue", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
    ]);
    const wait = f.replies!.waitQuestion(key, id, toolUseId, 30_000);
    await apiSettled(() => f.db.telegramQuestionMessagesForQuestion(id).some(item => !item.prompt), "question card");
    const card = f.db.telegramQuestionMessagesForQuestion(id).find(item => !item.prompt)!;
    tapQuestion(f, "cancel-question", id, 0, "x", card.messageId);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1, "terminal fallback cancellation");
    expect(await wait).toEqual({ status: 409 });
    expect(f.db.getQuestionInvocation(id, key)?.state).toBe("cancelled");
    expect(f.db.telegramQuestionMessagesForQuestion(id)).toHaveLength(0);
  });

  test.each(["cancel", "expire"] as const)("%s from the hook removes the Telegram keyboard while terminal input remains pending", async action => {
    const f = await pairedFixture({ repliesEnabled: true, observeReplies: true, clock: { now: Date.now() } });
    const { id, key, toolUseId } = registerClaudeQuestion(f, `hook-${action}`, [
      { id: "route", question: "Which route?", options: [{ label: "Local" }, { label: "Remote" }] },
    ]);
    await apiSettled(() => f.db.telegramQuestionMessagesForQuestion(id).some(item => !item.prompt), "question card");
    const card = f.db.telegramQuestionMessagesForQuestion(id).find(item => !item.prompt)!;
    if (action === "cancel") expect(f.replies!.cancelQuestion(id, key, toolUseId)).toBe(true);
    else { f.clock.now += 60_000; f.replies!.sweep(); }
    await apiSettled(() => f.bot.calls.some(call => call.method === "editMessageReplyMarkup" &&
      call.body.message_id === card.messageId), "terminal fallback keyboard removal");
    expect(f.db.telegramQuestionMessagesForQuestion(id)).toHaveLength(0);
    expect(f.db.getSession(key)).toMatchObject({ status: "needs_input", needsReason: "question" });
    expect(f.bot.calls.filter(call => call.method === "editMessageReplyMarkup" && call.body.message_id === card.messageId)
      .at(-1)?.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  test.each([false, true])("keeps OMP's exact question reply envelope with multi-select=%s", async multi => {
    const f = await pairedFixture({ repliesEnabled: true, clock: { now: Date.now() } });
    const questionId = "omp-question-identity";
    const row = f.db.applyEvent({ host: "synthetic-host", harness: "omp", sessionId: "telegram-omp-question",
      kind: "question", ts: f.clock.now, text: "Which color?", interactive: true, questionIdentity: questionId,
      questionData: [{ id: "color-choice", question: "Which color?", options: [{ label: "Red & gold" }, { label: "Blue" }], multi }] });
    f.telegram.observe(row, "question");
    await apiSettled(() => f.db.telegramQuestionMessagesForQuestion(questionId).some(item => !item.prompt), "OMP question card");
    const card = f.db.telegramQuestionMessagesForQuestion(questionId).find(item => !item.prompt)!;
    tapQuestion(f, "omp-select", questionId, 0, "1", card.messageId);
    await eventually(() => f.bot.count("answerCallbackQuery") === 1, "OMP selection");
    if (multi) {
      expect(f.db.queuedReplies()).toHaveLength(0);
      tapQuestion(f, "omp-submit", questionId, 0, "s", card.messageId);
      await eventually(() => f.bot.count("answerCallbackQuery") === 2, "OMP answer");
    }

    const reply = f.db.queuedReplies()[0]!;
    expect(reply.answersQuestion).toBe(questionId);
    expect(reply.text).toBe('"color-choice": {"selectedOptions":["Blue"]}');
    expect(reply.source).toBe("telegram");
    expect(reply.actor).toBe(`telegram:${owner}`);
    expect(f.db.telegramQuestionMessagesForQuestion(questionId)).toHaveLength(0);
  });
});

describe("Telegram server routes", () => {
  test("an invalid API base disables Telegram without network access", async () => {
    const db = new DashDB(":memory:");
    const bot = new FakeBot();
    const telegram = createTelegram({ db, apiBase: "http://example.invalid", readToken: async () => token });
    try {
      telegram.start();
      expect(telegram.health().state).toBe("disabled");
      expect(bot.calls).toHaveLength(0);
    } finally { telegram.close(); bot.close(); db.close(); }
  });
  test("health is disabled when DASH_TELEGRAM is not 1", async () => {
    const old = process.env.DASH_TELEGRAM;
    delete process.env.DASH_TELEGRAM;
    const app = createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false });
    try {
      const health = await (await fetch(`http://127.0.0.1:${app.server.port}/healthz`)).json() as any;
      expect(health.telegram.state).toBe("disabled");
    } finally { app.close(); if (old === undefined) delete process.env.DASH_TELEGRAM; else process.env.DASH_TELEGRAM = old; }
  });
  test("the loopback API exposes the pairing code but health omits it", async () => {
    const bot = new FakeBot();
    const old = process.env.DASH_TELEGRAM;
    process.env.DASH_TELEGRAM = "1";
    const app = createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false,
      telegram: { apiBase: bot.base, readToken: async () => token } });
    try {
      const base = `http://127.0.0.1:${app.server.port}`;
      await eventually(() => bot.count("getUpdates") > 0);
      const info = await (await fetch(`${base}/api/telegram`)).json() as any;
      const health = await (await fetch(`${base}/healthz`)).json() as any;
      expect(info.pairingCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(health.telegram).not.toHaveProperty("pairingCode");
      expect(health.telegram).not.toHaveProperty("chatId");
    } finally { app.close(); bot.close(); if (old === undefined) delete process.env.DASH_TELEGRAM; else process.env.DASH_TELEGRAM = old; }
  });
  test("tailnet hides the pairing code and refuses unpair", async () => {
    const bot = new FakeBot();
    const names = ["DASH_TELEGRAM", "DASH_ALLOWED_HOSTS", "DASH_ALLOWED_PEERS", "DASH_TAILNET_PORT"] as const;
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    process.env.DASH_TELEGRAM = "1";
    process.env.DASH_ALLOWED_HOSTS = "dash.tailnet.test";
    process.env.DASH_ALLOWED_PEERS = "192.0.2.10";
    delete process.env.DASH_TAILNET_PORT;
    const app = createDashServer({ port: 0, tailnetPort: 0, dataPath: ":memory:", backfill: false, liveness: false,
      telegram: { apiBase: bot.base, readToken: async () => token } });
    try {
      await eventually(() => bot.count("getUpdates") > 0);
      const headers = { Host: "dash.tailnet.test", "X-Forwarded-For": "192.0.2.10" };
      const remote = `http://127.0.0.1:${app.tailnetServer!.port}`;
      const info = await (await fetch(`${remote}/api/telegram`, { headers })).json() as any;
      expect(info.pairingCode).toBeNull();
      const unpair = await fetch(`${remote}/api/telegram/unpair`, { method: "POST", headers });
      expect(unpair.status).toBe(403);
    } finally {
      app.close(); bot.close();
      for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
});

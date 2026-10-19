import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashDB, type ResponseDTO, type ResponsePage, type SearchPage, type SearchResult } from "../src/db.ts";
import { createDashServer } from "../src/server.ts";
import { localHost } from "../src/normalize.ts";
import { SseReader } from "./sse.ts";

type App = ReturnType<typeof createDashServer>;
type SourceInventoryForTest = {
  generatedAt: number;
  staleAfterMs: number;
  unlabelledPeerEntries: number;
  sources: {
    host: string;
    configured: boolean;
    status: "reporting" | "stale" | "unreported" | "unknown";
    lastReportAt: number | null;
    lastHeartbeatAt: number | null;
    accounts: {
      accountAlias: string | null;
      sessions: {
        key: string;
        displayName: string;
        harness: "claude" | "omp";
        status: string;
        lastActivity: number;
        interactive: boolean;
      }[];
    }[];
  }[];
};
let app: App;
let base: string;
let tailnetBase: string;
let originalEnv: Record<string, string | undefined>;
const remoteHeaders = { Host: "dash.tailnet.test", "X-Forwarded-For": "192.0.2.10" };
const headers = {
  "Content-Type": "application/json",
  "X-Dash-Host": "synthetic-host",
  "X-Dash-Entrypoint": "cli",
  "X-Dash-Attended": "1",
};
const sessionId = "synthetic-session";
const key = `synthetic-host|claude|${sessionId}`;
const payload = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name, session_id: sessionId, cwd: "/synthetic/project", ...extra });
const ingest = (body: string, path = "/ingest/claude") =>
  fetch(`${base}${path}`, { method: "POST", headers, body });
const getJson = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>;

beforeEach(() => {
  originalEnv = Object.fromEntries(["DASH_TAILNET_PORT", "DASH_ALLOWED_HOSTS", "DASH_ALLOWED_PEERS", "DASH_TG_TOPICS", "DASH_TELEGRAM", "DASH_REPLIES", "DASH_TELEGRAM_API_BASE", "DASH_JUDGE", "DASH_CODEX_BIN"].map(name => [name, process.env[name]]));
  process.env.DASH_TAILNET_PORT = "";
  process.env.DASH_ALLOWED_HOSTS = "";
  process.env.DASH_ALLOWED_PEERS = "";
  process.env.DASH_TG_TOPICS = "";
  process.env.DASH_TELEGRAM = "";
  process.env.DASH_REPLIES = "";
  process.env.DASH_JUDGE = "";
  process.env.DASH_CODEX_BIN = "";
  app = createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false });
  base = `http://127.0.0.1:${app.server.port}`;
});
afterEach(() => {
  app.close();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
function startTailnet(now?: () => number, peers = " , 192.0.2.10 , ") {
  app.close();
  process.env.DASH_ALLOWED_HOSTS = " DASH.TAILNET.TEST , ";
  process.env.DASH_ALLOWED_PEERS = peers;
  app = createDashServer({ port: 0, tailnetPort: 0, dataPath: ":memory:", backfill: false, liveness: false, now });
  base = `http://127.0.0.1:${app.server.port}`;
  tailnetBase = `http://127.0.0.1:${app.tailnetServer!.port}`;
}

function enableTopics() {
  app.close();
  process.env.DASH_TG_TOPICS = "1";
  app = createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false });
  base = `http://127.0.0.1:${app.server.port}`;
}

function enableActionRoutes() {
  app.close();
  process.env.DASH_TG_TOPICS = "1";
  process.env.DASH_REPLIES = "1";
  app = createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false });
  base = `http://127.0.0.1:${app.server.port}`;
}

function projectPost(path: string, body: unknown, origin = base, extra: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
}

const fakeBotToken = "123456:tokenaaaa_tokenbbbb_tokencccc_test";
type BotCall = { method: string; body: Record<string, any> };
class FakeBot {
  readonly calls: BotCall[] = [];
  private nextMessageId = 1;
  readonly server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const method = new URL(request.url).pathname.split("/").at(-1)!;
    const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, any> : {};
    this.calls.push({ method, body });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "dash_test_bot" } });
    if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
    if (method === "getUpdates") return Response.json({ ok: true, result: [] });
    if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: this.nextMessageId++ } });
    if (method === "answerCallbackQuery") return Response.json({ ok: true, result: true });
    return Response.json({ ok: false, error_code: 404 }, { status: 404 });
  } });
  get base() { return `http://127.0.0.1:${this.server.port}`; }
  close() { this.server.stop(true); }
}

describe("ingest contract", () => {
  for (const [name, body] of [
    ["valid event", payload("SessionStart")],
    ["malformed JSON", "{"],
    ["empty body", ""],
    ["body larger than 2 MB", "x".repeat(3 * 1024 * 1024)],
    ["unknown event", payload("SyntheticUnknown")],
  ] as const) {
    test(`acknowledges ${name} with exact JSON body within 50 ms`, async () => {
      const start = performance.now();
      const response = await ingest(body);
      const elapsed = performance.now() - start;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("application/json");
      expect(await response.text()).toBe("{}");
      expect(elapsed).toBeLessThan(50);
    });
  }

  test("acknowledges malformed OMP JSON with the same contract", async () => {
    const response = await ingest("{", "/ingest/omp");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("application/json");
    expect(await response.text()).toBe("{}");
  });
});

describe("sessions and timeline API", () => {
  async function scriptedEvents() {
    await ingest(payload("SessionStart"));
    await ingest(payload("UserPromptSubmit", { prompt: "synthetic prompt" }));
    await ingest(payload("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "synthetic question?" }] } }));
    await ingest(payload("PostToolUse", { tool_name: "AskUserQuestion" }));
    for (let i = 1; i <= 4; i++) await ingest(payload("Stop", { last_assistant_message: `synthetic response ${i}` }));
  }

  test("returns the three newest responses and counts all unread responses", async () => {
    await scriptedEvents();
    const { sessions } = await getJson("/api/sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("your_turn");
    expect(sessions[0].unreadCount).toBe(4);
    expect(sessions[0].lastResponses.map((r: any) => r.text)).toEqual([
      "synthetic response 4", "synthetic response 3", "synthetic response 2",
    ]);
  });

  test("marking a session seen clears its unread count", async () => {
    await scriptedEvents();
    const response = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/seen`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    });
    expect(response.status).toBe(200);
    const { sessions } = await getJson("/api/sessions");
    expect(sessions[0].unreadCount).toBe(0);
  });

  test("timeline before cursor returns only older responses", async () => {
    await scriptedEvents();
    const first = (await getJson("/api/timeline?limit=2")).responses;
    expect(first.map((r: any) => r.text)).toEqual(["synthetic response 4", "synthetic response 3"]);
    const second = (await getJson(`/api/timeline?limit=2&before=${first[1].ts}`)).responses;
    expect(second.map((r: any) => r.text)).toEqual(["synthetic response 2", "synthetic response 1"]);
  });

  test("session response history pages beyond the three-response session DTO without marking rows seen", async () => {
    const event = { host: "synthetic-host", harness: "claude" as const, sessionId, kind: "response" as const,
      interactive: true, ts: 1_700_000_000_000 };
    for (let index = 1; index <= 7; index++) {
      app.db.applyEvent({ ...event, text: `synthetic history response ${index}` });
    }
    app.db.applyEvent({ ...event, sessionId: "synthetic-other-session", text: "response from another session" });

    const route = `/api/sessions/${encodeURIComponent(key)}/responses`;
    const all: ResponsePage["responses"] = [];
    let before: number | undefined, hasMore = true;
    while (hasMore) {
      const page = await (await fetch(`${base}${route}?limit=2${before === undefined ? "" : `&before=${before}`}`)).json() as ResponsePage;
      expect(page.responses.length).toBeLessThanOrEqual(2);
      all.push(...page.responses);
      hasMore = page.hasMore;
      if (hasMore) before = page.responses.at(-1).ts;
    }
    expect(all.map(response => response.text)).toEqual(Array.from({ length: 7 }, (_, index) =>
      `synthetic history response ${7 - index}`));
    expect(all.every(response => response.sessionKey === key)).toBe(true);
    expect(new Set(all.map(response => response.ts)).size).toBe(7);
    expect(all.every(response => response.seen === false)).toBe(true);
    expect(app.db.getSession(key)?.unreadCount).toBe(7);

    const defaultPage = await (await fetch(`${base}${route}`)).json() as ResponsePage;
    expect(defaultPage.responses).toHaveLength(7);
    expect(defaultPage.hasMore).toBe(false);
  });

  test("session response history rejects invalid cursors and pagination but reads headless and ended sessions", async () => {
    const route = `/api/sessions/${encodeURIComponent(key)}/responses`;
    for (const query of ["before=not-a-timestamp", "before=1.5", "limit=0", "limit=-1", "limit=1.5", "limit=101"]) {
      const response = await fetch(`${base}${route}?${query}`);
      expect(response.status).toBe(400);
    }
    expect((await fetch(`${base}/api/sessions/${encodeURIComponent("synthetic-host|claude|missing")}/responses`)).status).toBe(404);
    expect((await fetch(`${base}/api/sessions/%ZZ/responses`)).status).toBe(400);

    app.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "synthetic-headless", kind: "response",
      ts: 1_700_000_000_100, text: "headless response", interactive: false });
    const headless = await fetch(`${base}/api/sessions/${encodeURIComponent("synthetic-host|claude|synthetic-headless")}/responses`);
    expect(headless.status).toBe(200);
    expect(await headless.json()).toMatchObject({ responses: [{ text: "headless response" }], hasMore: false });

    const endedEvent = { host: "synthetic-host", harness: "claude" as const, sessionId: "synthetic-ended", interactive: true };
    app.db.applyEvent({ ...endedEvent, kind: "response", ts: 1_700_000_000_200, text: "ended response" });
    app.db.applyEvent({ ...endedEvent, kind: "session_end", ts: 1_700_000_000_201 });
    const ended = await fetch(`${base}/api/sessions/${encodeURIComponent("synthetic-host|claude|synthetic-ended")}/responses`);
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ responses: [{ text: "ended response" }], hasMore: false });
  });

  test("timeline hides headless but includes ended sessions by default", async () => {
    const headlessHeaders = { "Content-Type": "application/json", "X-Dash-Host": "synthetic-host", "X-Dash-Entrypoint": "sdk-py", "X-Dash-Attended": "0" };
    await fetch(`${base}/ingest/claude`, { method: "POST", headers: headlessHeaders, body: JSON.stringify({ ...JSON.parse(payload("Stop", { last_assistant_message: "synthetic headless response" })), session_id: "synthetic-headless" }) });
    expect((await getJson("/api/sessions")).sessions).toHaveLength(0);
    expect((await getJson("/api/timeline")).responses).toHaveLength(0);
    expect((await getJson("/api/timeline?headless=1")).responses).toHaveLength(1);
    await ingest(payload("Stop", { last_assistant_message: "synthetic attended response" }));
    expect((await getJson("/api/timeline")).responses.map((r: any) => r.text)).toEqual(["synthetic attended response"]);
    expect((await getJson("/api/timeline?host=other-host")).responses).toHaveLength(0);
    expect((await getJson("/api/timeline?harness=omp")).responses).toHaveLength(0);
    await ingest(payload("SessionEnd"));
    expect((await getJson("/api/timeline")).responses).toHaveLength(1);
    expect((await getJson("/api/sessions")).sessions).toHaveLength(0);
    expect((await getJson("/api/sessions?ended=1")).sessions).toHaveLength(1);
  });
});
describe("output search API", () => {
  function addResponse(sessionId: string, text: string, options: {
    host?: string; harness?: "claude" | "omp"; cwd?: string; title?: string; accountAlias?: string;
    interactive?: boolean; ts?: number;
  } = {}) {
    const session = app.db.applyEvent({
      host: options.host ?? "search-host", harness: options.harness ?? "claude", sessionId, kind: "response",
      ts: options.ts ?? 1_700_000_000_000, text, interactive: options.interactive ?? true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.accountAlias === undefined ? {} : { accountAlias: options.accountAlias }),
    });
    const response = session.lastResponses[0];
    if (!response) throw new Error("response fixture was not retained");
    return { key: session.key, id: response.id, ts: response.ts };
  }

  test("search treats punctuation literally and returns only bounded contextual text", async () => {
    const first = addResponse("literal-one",
      `${"context ".repeat(100)}Needle%_ <img src=x onerror=1>${" ending".repeat(100)}`);
    addResponse("literal-two", `${"context ".repeat(100)}NeedleXX without HTML`);
    const params = new URLSearchParams({ q: "  needle%_  " });
    const { results, nextCursor } = await getJson(`/api/search?${params}`) as SearchPage;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ key: first.key, responseId: first.id, match: "response" });
    expect(Object.keys(results[0]).sort()).toEqual([
      "accountAlias", "displayName", "excerpt", "harness", "host", "key", "match", "project", "responseId", "ts",
    ]);
    expect(results[0].excerpt.length).toBeLessThanOrEqual(400);
    expect(results[0].excerpt).toContain("Needle%_");
    expect(results[0].excerpt).toContain("<img src=x onerror=1>");
    expect(nextCursor).toBeNull();
    const html = await getJson(`/api/search?${new URLSearchParams({ q: "<img src=x onerror=1>" })}`) as SearchPage;
    expect(html.results.map(result => result.responseId)).toEqual([first.id]);
    addResponse("unicode-excerpt", `${"🌙".repeat(300)}needle unicode`);
    const unicode = await getJson(`/api/search?${new URLSearchParams({ q: "needle unicode" })}`) as SearchPage;
    expect(unicode.results[0].excerpt.length).toBeLessThanOrEqual(400);
    expect(unicode.results[0].excerpt).toContain("needle unicode");
  });

  test("identity-only excerpts retain the matching field and phrase even with an output or long path", async () => {
    const cwd = `/work/${"folder/".repeat(100)}needle-path/${"end/".repeat(100)}`;
    const retained = addResponse("identity-with-output", "Unrelated retained output", { cwd, title: "Visible title" });
    const empty = app.db.applyEvent({
      host: "search-host", harness: "omp", sessionId: "identity-without-output", kind: "prompt",
      ts: 1_700_000_000_100, text: "Unrelated prompt", cwd, title: "Another title", interactive: true,
    });
    const page = await getJson(`/api/search?${new URLSearchParams({ q: "NEEDLE-PATH" })}`) as SearchPage;
    expect(page.results.map(result => [result.key, result.responseId, result.match])).toEqual([
      [empty.key, null, "identity"], [retained.key, retained.id, "identity"],
    ]);
    for (const result of page.results) {
      expect(result.excerpt).toContain("needle-path");
      expect(result.excerpt.length).toBeLessThanOrEqual(400);
      expect(result.excerpt).not.toContain("Unrelated retained output");
    }
    app.db.setSessionIdentity(retained.key, "Renamed session", null);
    const titleMatch = await getJson(`/api/search?${new URLSearchParams({ q: "Visible title" })}`) as SearchPage;
    expect(titleMatch.results[0]).toMatchObject({ key: retained.key, displayName: "Renamed session", match: "identity" });
    expect(titleMatch.results[0].excerpt).toContain("Visible title");
  });

  test("rejects malformed search controls and treats an empty query as no search", async () => {
    expect(await getJson("/api/search")).toEqual({ results: [], nextCursor: null });
    expect(await getJson(`/api/search?${new URLSearchParams({ q: "   " })}`)).toEqual({ results: [], nextCursor: null });
    const invalid = [
      "limit=0", "limit=101", "limit=1.5", "harness=codex", "headless=true", "ended=",
      "cursor=not-a-cursor", "q=x&q=y", "unknown=value",
    ];
    for (const query of invalid) expect((await fetch(`${base}/api/search?${query}`)).status).toBe(400);
    expect((await fetch(`${base}/api/search?${new URLSearchParams({ q: "x".repeat(257) })}`)).status).toBe(400);
  });

  test("search filters use effective project and account identities, including unassigned values", async () => {
    enableTopics();
    app.db.setSetting("projects.rules", JSON.stringify([{ pattern: "^/work/([^/]+)$", project: "project-$1" }]));
    const owned = addResponse("owned", "scoped phrase", {
      host: "filter-host", cwd: "/work/alpha", accountAlias: "reported-account",
    });
    app.db.setSessionIdentity(owned.key, "Owner label", "owner-account");
    addResponse("owned", "another retained result", {
      host: "filter-host", cwd: "/work/alpha", accountAlias: "reported-account",
    });
    const unassigned = addResponse("unassigned", "scoped phrase", {
      host: "filter-host", harness: "omp", cwd: "/",
    });
    app.db.setSessionIdentity(unassigned.key, "Clear label", "");

    expect(app.db.getSession(owned.key)?.project).toBe("project-alpha");
    const ownedSearch = await getJson(`/api/search?${new URLSearchParams({
      q: "scoped phrase", host: "filter-host", harness: "claude", project: "project-alpha", account: "owner-account",
    })}`) as SearchPage;
    expect(ownedSearch.results.map(result => result.key)).toEqual([owned.key]);
    expect(ownedSearch.results[0]).toMatchObject({ project: "project-alpha", accountAlias: "owner-account" });
    const unassignedSearch = await getJson(`/api/search?${new URLSearchParams({
      q: "scoped phrase", project: "", account: "",
    })}`) as SearchPage;
    expect(unassignedSearch.results.map(result => result.key)).toEqual([unassigned.key]);
    expect(unassignedSearch.results[0]).toMatchObject({ project: "", accountAlias: "" });
    const identitySearch = await getJson(`/api/search?${new URLSearchParams({ q: "project-alpha" })}`) as SearchPage;
    expect(identitySearch.results.map(result => [result.key, result.match])).toEqual([
      [owned.key, "identity"], [owned.key, "identity"],
    ]);
  });

  test("headless and ended switches include exactly their hidden session classes", async () => {
    const active = addResponse("visible-active", "visibility phrase");
    const headless = addResponse("visible-headless", "visibility phrase", { interactive: false });
    const ended = addResponse("visible-ended", "visibility phrase");
    app.db.applyEvent({
      host: "search-host", harness: "claude", sessionId: "visible-ended", kind: "session_end",
      ts: 1_700_000_000_200, interactive: true,
    });

    const readKeys = async (params: URLSearchParams) =>
      (await getJson(`/api/search?${params}`) as SearchPage).results.map(result => result.key).sort();
    expect(await readKeys(new URLSearchParams({ q: "visibility phrase" }))).toEqual([active.key].sort());
    expect(await readKeys(new URLSearchParams({ q: "visibility phrase", headless: "1" })))
      .toEqual([active.key, headless.key].sort());
    expect(await readKeys(new URLSearchParams({ q: "visibility phrase", ended: "1" })))
      .toEqual([active.key, ended.key].sort());
    expect(await readKeys(new URLSearchParams({ q: "visibility phrase", headless: "1", ended: "1" })))
      .toEqual([active.key, headless.key, ended.key].sort());
  });

  test("cursor pagination preserves timestamp ties and no-response identity results", async () => {
    const responses = Array.from({ length: 7 }, (_, index) =>
      addResponse(`tie-response-${index}`, `shared page phrase ${index}`));
    app.db.sqlite.query("UPDATE responses SET ts=? WHERE text LIKE ?").run(1_700_000_000_500, "%shared page phrase%");
    const firstParams = new URLSearchParams({ q: "shared page phrase", limit: "3" });
    const firstPage = await getJson(`/api/search?${firstParams}`) as SearchPage;
    expect(firstPage.results.map(result => result.responseId))
      .toEqual(responses.map(response => response.id).sort((left, right) => right - left).slice(0, 3));
    const firstCursor = firstPage.nextCursor;
    if (!firstCursor) throw new Error("expected a continuation cursor");
    expect((await fetch(`${base}/api/search?${new URLSearchParams({
      q: "shared page phrase", limit: "4", cursor: firstCursor,
    })}`)).status).toBe(400);
    const collected: SearchResult[] = [...firstPage.results];
    let cursor: string | null = firstCursor;
    while (cursor) {
      const page = await getJson(`/api/search?${new URLSearchParams({ q: "shared page phrase", limit: "3", cursor })}`) as SearchPage;
      collected.push(...page.results);
      cursor = page.nextCursor;
    }
    expect(collected).toHaveLength(responses.length);
    expect(new Set(collected.map(result => result.responseId)).size).toBe(responses.length);
    expect(collected.map(result => result.responseId))
      .toEqual(responses.map(response => response.id).sort((left, right) => right - left));

    const stamp = 1_700_000_000_700;
    for (let index = 0; index < 4; index++) {
      app.db.applyEvent({
        host: "search-host", harness: "claude", sessionId: `identity-tie-${index}`, kind: "session_start",
        ts: stamp, title: `label phrase ${index}`, cwd: "/", interactive: true,
      });
    }
    const identityFirst = await getJson(`/api/search?${new URLSearchParams({ q: "label phrase", limit: "2" })}`) as SearchPage;
    expect(identityFirst.results).toHaveLength(2);
    expect(identityFirst.results.every(result => result.responseId === null)).toBe(true);
    const identityCursor = identityFirst.nextCursor;
    if (!identityCursor) throw new Error("expected a continuation cursor");
    const identitySecond = await getJson(`/api/search?${new URLSearchParams({
      q: "label phrase", limit: "2", cursor: identityCursor,
    })}`) as SearchPage;
    expect([...identityFirst.results, ...identitySecond.results].map(result => result.key))
      .toEqual(["identity-tie-0", "identity-tie-1", "identity-tie-2", "identity-tie-3"]
        .map(id => `search-host|claude|${id}`));
  });

  test("exact response reads are session-scoped and do not change seen state", async () => {
    const first = addResponse("exact-read", "first captured response");
    const second = addResponse("exact-read", "second captured response");
    const other = addResponse("different-session", "other captured response");
    const path = (key: string, id: number | string) =>
      `/api/sessions/${encodeURIComponent(key)}/responses/${id}`;
    const before = app.db.getSession(first.key)!.unreadCount;
    const response = await getJson(path(first.key, first.id)) as { response: ResponseDTO };
    expect(response.response).toMatchObject({ id: first.id, sessionKey: first.key, text: "first captured response", seen: false });
    expect(response.response.id).not.toBe(second.id);
    expect(app.db.getSession(first.key)?.unreadCount).toBe(before);
    expect((await fetch(`${base}${path(other.key, first.id)}`)).status).toBe(404);
    expect((await fetch(`${base}${path(first.key, 9_999_999)}`)).status).toBe(404);
    for (const id of ["0", "-1", "1.5", "9007199254740992", "not-an-id"]) {
      expect((await fetch(`${base}${path(first.key, id)}`)).status).toBe(400);
    }
    expect((await fetch(`${base}/api/sessions/%ZZ/responses/${first.id}`)).status).toBe(400);
    app.db.sqlite.query("DELETE FROM responses WHERE id=?").run(first.id);
    expect((await fetch(`${base}${path(first.key, first.id)}`)).status).toBe(404);
    app.db.sqlite.query("DELETE FROM sessions WHERE key=?").run(other.key);
    expect((await fetch(`${base}${path(other.key, other.id)}`)).status).toBe(404);
  });
  test("read-position returns the oldest retained unread response without marking history", async () => {
    const ts = 1_700_000_100_000;
    const first = addResponse("read-position", "first retained response", { ts });
    const second = addResponse("read-position", "second retained response", { ts:ts + 1 });
    const tiedTs = ts + 10;
    app.db.sqlite.query("UPDATE responses SET ts=? WHERE id IN (?,?)").run(tiedTs, first.id, second.id);
    const route = `/api/sessions/${encodeURIComponent(first.key)}/read-position`;
    const position = await getJson(route) as { firstUnread: ResponseDTO | null; unreadCount: number; retainedCount: number };
    expect(Object.keys(position).sort()).toEqual(["firstUnread", "retainedCount", "unreadCount"]);
    expect(position).toMatchObject({
      firstUnread: {
        id:first.id, sessionKey:first.key, ts:tiedTs, text:"first retained response", seen:false,
        host:"search-host", harness:"claude", sessionId:"read-position", displayName:"read-position",
      },
      unreadCount:2, retainedCount:2,
    });
    expect(app.db.getSession(first.key)?.unreadCount).toBe(2);
    expect((await fetch(`${base}/api/sessions/${encodeURIComponent("search-host|claude|missing")}/read-position`)).status).toBe(404);
    expect((await fetch(`${base}/api/sessions/%ZZ/read-position`)).status).toBe(400);
  });

  test("read-position includes retained output from ended and headless sessions", async () => {
    const headless = app.db.applyEvent({
      host:"read-host", harness:"claude", sessionId:"headless-read", kind:"response",
      ts:1_700_000_200_000, text:"headless retained response", interactive:false,
    });
    const ended = app.db.applyEvent({
      host:"read-host", harness:"claude", sessionId:"ended-read", kind:"response",
      ts:1_700_000_200_001, text:"ended retained response", interactive:true,
    });
    app.db.applyEvent({
      host:"read-host", harness:"claude", sessionId:"ended-read", kind:"session_end",
      ts:1_700_000_200_002, interactive:true,
    });
    for (const session of [headless, ended]) {
      const position = await getJson(`/api/sessions/${encodeURIComponent(session.key)}/read-position`);
      expect(position).toMatchObject({
        firstUnread:{id:session.lastResponses[0].id, sessionKey:session.key, seen:false},
        unreadCount:1, retainedCount:1,
      });
    }
  });

  test("exact acknowledgement validates scope and version, retries safely, and leaves newer output unread", async () => {
    const ts = 1_700_000_300_000;
    const first = addResponse("exact-ack", "first acknowledgement target", { ts });
    const second = addResponse("exact-ack", "second acknowledgement target", { ts:ts + 1 });
    const other = addResponse("different-ack-session", "other session target", { ts:ts + 2 });
    const responsePath = (key: string, id: number | string) =>
      `/api/sessions/${encodeURIComponent(key)}/responses/${id}/seen`;
    const positionPath = `/api/sessions/${encodeURIComponent(first.key)}/read-position`;
    const postSeen = (key: string, id: number | string, body: unknown) =>
      projectPost(responsePath(key, id), body);

    const missingOrigin = await fetch(`${base}${responsePath(first.key, first.id)}`, {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ts:first.ts}),
    });
    expect(missingOrigin.status).toBe(403);
    const malformedJson = await fetch(`${base}${responsePath(first.key, first.id)}`, {
      method:"POST", headers:{Origin:base, "Content-Type":"application/json"}, body:"{",
    });
    expect(malformedJson.status).toBe(400);
    const unsupportedMedia = await fetch(`${base}${responsePath(first.key, first.id)}`, {
      method:"POST", headers:{Origin:base, "Content-Type":"text/plain"}, body:JSON.stringify({ts:first.ts}),
    });
    expect(unsupportedMedia.status).toBe(415);
    for (const body of [
      {}, {ts:first.ts, extra:true}, {ts:first.ts + 0.5}, {ts:Number.MAX_SAFE_INTEGER + 1},
      {ts:"not-a-timestamp"}, null, [],
    ]) {
      expect((await postSeen(first.key, first.id, body)).status).toBe(400);
    }
    for (const id of ["0", "-1", "1.5", "9007199254740992", "not-an-id"]) {
      expect((await postSeen(first.key, id, {ts:first.ts})).status).toBe(400);
    }
    expect((await postSeen(first.key, other.id, {ts:other.ts})).status).toBe(404);
    expect((await postSeen(first.key, 9_999_999, {ts:first.ts})).status).toBe(404);
    expect((await postSeen("search-host|claude|missing", first.id, {ts:first.ts})).status).toBe(404);
    expect((await projectPost(`/api/sessions/%ZZ/responses/${first.id}/seen`, {ts:first.ts})).status).toBe(400);
    expect(app.db.getSession(first.key)?.unreadCount).toBe(2);
    expect(app.db.getSession(other.key)?.unreadCount).toBe(1);

    const controller = new AbortController();
    const streamResponse = await fetch(`${base}/api/stream`, { signal:controller.signal });
    const stream = new SseReader(streamResponse.body!.getReader());
    try {
      expect(await stream.nextFrame()).toBe(": connected");
      const acknowledged = await postSeen(first.key, first.id, {ts:first.ts});
      expect(acknowledged.status).toBe(200);
      const body = await acknowledged.json() as {
        ok:boolean; session:{key:string; unreadCount:number; capabilities?:unknown};
        readPosition:{firstUnread:ResponseDTO|null; unreadCount:number; retainedCount:number};
      };
      expect(body).toMatchObject({
        ok:true, session:{key:first.key, unreadCount:1},
        readPosition:{firstUnread:{id:second.id}, unreadCount:1, retainedCount:2},
      });
      expect(body.session.capabilities).toBeDefined();
      expect(Object.keys(body.readPosition).sort()).toEqual(["firstUnread", "retainedCount", "unreadCount"]);
      const published = await stream.nextEvent("session");
      expect(published).toMatchObject({key:first.key, unreadCount:1});

      const third = addResponse("exact-ack", "newer arriving response", {ts:ts + 3});
      expect(await getJson(positionPath)).toMatchObject({
        firstUnread:{id:second.id}, unreadCount:2, retainedCount:3,
      });
      const retries = await Promise.all([
        postSeen(first.key, second.id, {ts:second.ts}),
        postSeen(first.key, second.id, {ts:second.ts}),
      ]);
      expect(retries.map(response => response.status)).toEqual([200, 200]);
      expect(await Promise.all(retries.map(response => response.json()))).toEqual([
        expect.objectContaining({ok:true}), expect.objectContaining({ok:true}),
      ]);
      expect(await getJson(positionPath)).toMatchObject({
        firstUnread:{id:third.id}, unreadCount:1, retainedCount:3,
      });

      expect((await projectPost("/api/seen-all", {})).status).toBe(200);
      expect(await getJson(positionPath)).toEqual({firstUnread:null, unreadCount:0, retainedCount:3});
      expect((await getJson(`/api/sessions/${encodeURIComponent(other.key)}/read-position`)))
        .toMatchObject({firstUnread:null, unreadCount:0, retainedCount:1});
    } finally {
      await stream.close();
      controller.abort();
    }
  });

  test("replayed output rejects the old acknowledgement version and pruned output returns not found", async () => {
    const original = addResponse("replayed-ack", "reused live response", { ts:1_700_000_400_000 });
    const responsePath = (key: string, id: number) =>
      `/api/sessions/${encodeURIComponent(key)}/responses/${id}/seen`;
    const route = `/api/sessions/${encodeURIComponent(original.key)}/read-position`;
    const oldTs = app.db.sessionResponse(original.key, original.id)!.ts;
    expect((await projectPost(responsePath(original.key, original.id), {ts:oldTs})).status).toBe(200);
    app.db.applyEvent({
      host:"search-host", harness:"claude", sessionId:"replayed-ack", kind:"response",
      ts:oldTs + 1, text:"reused live response", interactive:true,
    });
    const replayed = app.db.sessionResponse(original.key, original.id)!;
    expect(replayed.ts).toBeGreaterThan(oldTs);
    expect(replayed.seen).toBe(false);
    const stale = await projectPost(responsePath(original.key, original.id), {ts:oldTs});
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({error:"stale_response"});
    expect(await getJson(route)).toMatchObject({firstUnread:{id:original.id}, unreadCount:1, retainedCount:1});

    const pruned = addResponse("pruned-ack", "pruned response", {ts:1_700_000_500_000});
    app.db.sqlite.query("DELETE FROM responses WHERE id=?").run(pruned.id);
    expect((await projectPost(responsePath(pruned.key, pruned.id), {ts:pruned.ts})).status).toBe(404);
    expect(await getJson(`/api/sessions/${encodeURIComponent(pruned.key)}/read-position`))
      .toEqual({firstUnread:null, unreadCount:0, retainedCount:0});
  });

  test("search never finds prompt or reply text", async () => {
    const captured = addResponse("content-boundary", "ordinary captured output");
    app.db.sqlite.query("UPDATE responses SET prompt=? WHERE id=?").run("prompt-only phrase", captured.id);
    app.db.enqueueReply(captured.key, "reply-only phrase", "web", "synthetic-agent", undefined, Date.now(), 10_000);
    for (const q of ["prompt-only phrase", "reply-only phrase"]) {
      expect((await getJson(`/api/search?${new URLSearchParams({ q })}`) as SearchPage).results).toEqual([]);
    }
  });
});


test("rejects forged hosts and foreign API origins while silently dropping unsafe ingest", async () => {
  const forged = await fetch(`${base}/api/sessions`, { headers: { Host: "other.example" } });
  expect(forged.status).toBe(403);
  const omp = JSON.stringify({host:"synthetic-host",harness:"omp",sessionId:"rejected",kind:"session_start",interactive:true});
  const dropped = await fetch(`${base}/ingest/omp`, {method:"POST",headers:{Host:"other.example","Content-Type":"application/json"},body:omp});
  expect(dropped.status).toBe(200);
  expect(await dropped.text()).toBe("{}");
  expect((await getJson("/api/sessions?headless=1")).sessions).toHaveLength(0);
  const plain = await fetch(`${base}/ingest/omp`, {method:"POST",headers:{"Content-Type":"text/plain"},body:omp});
  expect(await plain.text()).toBe("{}");
  expect((await getJson("/api/sessions?headless=1")).sessions).toHaveLength(0);
  expect((await getJson("/healthz")).rejected).toBe(2);
  expect((await fetch(`${base}/api/seen-all`, {method:"POST",headers:{Origin:"http://foreign.example","Content-Type":"application/json"}})).status).toBe(403);
  expect((await fetch(`${base}/api/seen-all`, {method:"POST",headers:{Origin:base,"Content-Type":"application/json"}})).status).toBe(200);
  process.env.DASH_ALLOWED_HOSTS = "dash.tailnet.test";
  process.env.DASH_ALLOWED_PEERS = "192.0.2.10";
  expect((await fetch(`${base}/api/sessions`, { headers: remoteHeaders })).status).toBe(403);
  expect((await fetch(`${base}/api/seen-all`, { method: "POST", headers: { ...remoteHeaders, Origin: "https://dash.tailnet.test" } })).status).toBe(403);
});

test("tailnet listener denies loopback Hosts and requires an allowed last forwarded peer", async () => {
  startTailnet();
  const api = (forwarded?: string, host = remoteHeaders.Host) => fetch(`${tailnetBase}/api/sessions`, {
    headers: { Host: host, ...(forwarded ? { "X-Forwarded-For": forwarded } : {}) },
  });
  expect((await api("192.0.2.10", `127.0.0.1:${app.tailnetServer!.port}`)).status).toBe(403);
  expect((await api("192.0.2.10", `localhost:${app.tailnetServer!.port}`)).status).toBe(403);
  process.env.DASH_ALLOWED_HOSTS += `,127.0.0.1:${app.tailnetServer!.port},localhost`;
  expect((await api("192.0.2.10", `127.0.0.1:${app.tailnetServer!.port}`)).status).toBe(403);
  expect((await api("192.0.2.10", "localhost")).status).toBe(403);
  expect((await api("192.0.2.10")).status).toBe(200);
  expect((await fetch(`${tailnetBase}/healthz`, { headers: remoteHeaders })).status).toBe(200);
  const controller = new AbortController();
  const stream = await fetch(`${tailnetBase}/api/stream`, { headers: remoteHeaders, signal: controller.signal });
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toStartWith("text/event-stream");
  await stream.body!.cancel();
  controller.abort();
  expect((await api("1.2.3.4")).status).toBe(403);
  expect((await api()).status).toBe(403);
  expect((await api("192.0.2.99, 192.0.2.10")).status).toBe(200);
  expect((await api("192.0.2.10, 192.0.2.99")).status).toBe(403);
  const dropped = await fetch(`${tailnetBase}/ingest/claude`, { method: "POST", headers: { ...headers, ...remoteHeaders, "X-Forwarded-For": "1.2.3.4" }, body: payload("SessionStart") });
  expect(dropped.status).toBe(200);
  expect(await dropped.text()).toBe("{}");
  expect((await getJson("/healthz")).rejected).toBe(1);
  expect((await getJson("/api/sessions?headless=1")).sessions).toHaveLength(0);
});

test("loopback listener rejects proxy headers and extra Hosts but accepts plain loopback", async () => {
  process.env.DASH_ALLOWED_HOSTS = remoteHeaders.Host;
  process.env.DASH_ALLOWED_PEERS = remoteHeaders["X-Forwarded-For"];
  for (const proxyHeader of ["X-Forwarded-For", "Tailscale-User-Login", "X-Forwarded-Host"]) {
    expect((await fetch(`${base}/api/sessions`, { headers: { [proxyHeader]: "192.0.2.10" } })).status).toBe(403);
  }
  const dropped = await fetch(`${base}/ingest/claude`, { method: "POST", headers: { ...headers, "X-Forwarded-For": "192.0.2.10" }, body: payload("SessionStart") });
  expect(dropped.status).toBe(200);
  expect(await dropped.text()).toBe("{}");
  expect(app.rejectedCount).toBe(1);
  expect((await getJson("/api/sessions?headless=1")).sessions).toHaveLength(0);
  expect((await fetch(`${base}/api/sessions`, { headers: { Host: remoteHeaders.Host } })).status).toBe(403);
  expect((await fetch(`${base}/api/sessions`, { headers: remoteHeaders })).status).toBe(403);
  expect((await fetch(`${base}/api/sessions`)).status).toBe(200);
});

test("loopback API writes accept only exact local origins and grant no preflight", async () => {
  const endpoint = `${base}/api/seen-all`;
  const port = app.server.port;
  const post = (origin: string | undefined, extra: Record<string, string> = {}) => fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin === undefined ? {} : { Origin: origin }), ...extra },
  });
  for (const origin of [undefined, "null", "not a URL", "http://foreign.example", `https://dash.tailnet.test`, `http://127.0.0.1:${port + 1}`]) {
    const response = await post(origin);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('{"error":"forbidden"}');
  }
  const localhostOrigin = await post(`http://localhost:${port}`);
  expect(localhostOrigin.status).toBe(200);
  const ipv6Origin = await post(`http://[::1]:${port}`, { Host: `localhost:${port}` });
  expect(ipv6Origin.status).toBe(200);
  expect(ipv6Origin.headers.get("access-control-allow-origin")).toBeNull();
  const forgedProxy = await post(base, { "X-Forwarded-Host": "dash.tailnet.test" });
  expect(forgedProxy.status).toBe(403);
  expect(await forgedProxy.text()).toBe('{"error":"forbidden"}');

  const preflight = await fetch(endpoint, { method: "OPTIONS", headers: {
    Origin: base, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type",
  } });
  expect(preflight.status).toBe(404);
  expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  expect(preflight.headers.get("access-control-allow-methods")).toBeNull();
});

test("tailnet API writes require the tailnet HTTPS origin and an allowed peer", async () => {
  startTailnet();
  const post = (origin: string | undefined, contentType?: string, extra: Record<string, string> = {}) => fetch(`${tailnetBase}/api/seen-all`, {
    method: "POST", headers: { ...remoteHeaders, ...(origin === undefined ? {} : { Origin: origin }), ...(contentType ? { "Content-Type": contentType } : {}), ...extra },
  });
  for (const origin of [undefined, "null", "not a URL", "http://dash.tailnet.test", base, "https://other.tailnet.test", "https://dash.tailnet.test:443"]) {
    const response = await post(origin, "application/json");
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('{"error":"forbidden"}');
  }
  for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=synthetic"]) {
    const response = await post("https://dash.tailnet.test", contentType);
    expect(response.status).toBe(415);
    expect(await response.text()).toBe('{"error":"unsupported media type"}');
  }
  const accepted = await post("https://dash.tailnet.test", "Application/JSON; charset=UTF-8");
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("access-control-allow-origin")).toBeNull();
  const forgedHost = await post("https://dash.tailnet.test", "application/json", { Host: "evil.tailnet.test" });
  expect(forgedHost.status).toBe(403);
  expect(await forgedHost.text()).toBe('{"error":"forbidden"}');
});

test("tailnet port is validated from env and option; blank disables and options zero stays ephemeral", async () => {
  expect(app.tailnetServer).toBeUndefined();
  expect((await getJson("/healthz")).tailnetPort).toBeNull();

  app.close();
  app = createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false, tailnetPort: 0 });
  expect(app.tailnetServer?.port).toBeGreaterThan(0);

  app.close();
  for (const value of ["478o", "70000"]) {
    process.env.DASH_TAILNET_PORT = value;
    expect(() => createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false }))
      .toThrow("DASH_TAILNET_PORT must be an integer port 1-65535");
  }

  app.close();
  process.env.DASH_TAILNET_PORT = "";
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const expectedPort = probe.port;
  probe.stop(true);
  process.env.DASH_TAILNET_PORT = `  ${expectedPort}  `;
  app = createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false });
  expect(app.tailnetServer?.port).toBe(expectedPort);
  expect((await (await fetch(`http://127.0.0.1:${app.server.port}/healthz`)).json()).tailnetPort).toBe(expectedPort);

  app.close();
  for (const tailnetPort of [-1, 65536, Number.NaN]) {
    expect(() => createDashServer({ port: 0, tailnetPort, dataPath: ":memory:", backfill: false, liveness: false }))
      .toThrow("DASH_TAILNET_PORT must be an integer port 1-65535");
  }
});

test("the local listener cannot bind a public interface", () => {
  expect(() => createDashServer({ port: 0, hostname: "0.0.0.0", dataPath: ":memory:", backfill: false, liveness: false }))
    .toThrow("DASH_BIND must be a loopback address");
});

test("remote Claude pushes track liveness, absence, recovery and health age", async () => {
  let clock = 1_000_000;
  startTailnet(() => clock);
  const record = { sessionId: "s1", pid: 10, cwd: "/synthetic", name: "n", status: "idle" };
  const remoteKey = "mbp|claude|s1";
  const push = (body: unknown, host = "mbp") => fetch(`${tailnetBase}/ingest/liveness/claude`, {
    method: "POST", headers: { ...remoteHeaders, "Content-Type": "application/json", "X-Dash-Host": host }, body: JSON.stringify(body),
  });
  expect(await (await push([record])).text()).toBe("{}");
  expect(app.db.getSession(remoteKey)).toMatchObject({ host: "mbp", alive: true, status: "your_turn" });
  expect(app.db.getSession(remoteKey)?.displayName).toBe("n");
  expect((await getJson("/healthz")).remoteHosts.mbp).toBe(0);
  clock += 1_000;
  await push([]);
  expect(app.db.getSession(remoteKey)?.alive).toBe(false);
  clock += 119_000;
  await push([]);
  expect(app.db.getSession(remoteKey)?.status).toBe("your_turn");
  await push({ agents: [record] });
  expect(app.db.getSession(remoteKey)?.alive).toBe(true);
  expect((app.db.sqlite.query("SELECT dead_since FROM sessions WHERE key=?").get(remoteKey) as any).dead_since).toBeNull();
  clock += 10_000;
  await push([]);
  clock += 120_000;
  await push([]);
  expect(app.db.getSession(remoteKey)).toMatchObject({ alive: false, status: "ended" });
  clock += 3_000;
  expect((await getJson("/healthz")).remoteHosts.mbp).toBe(3);
});

test("remote liveness rejects bad hosts, bad bodies and disallowed peers without changing local rows", async () => {
  startTailnet();
  const local = localHost();
  const localKey = `${local}|claude|local-synthetic`;
  app.db.markLiveness("claude", [{ host: local, harness: "claude", sessionId: "local-synthetic", pid: 123, detail: "busy" }], local, Date.now(), () => false);
  const push = (host: string | undefined, body: unknown, extra: Record<string, string> = {}) => fetch(`${tailnetBase}/ingest/liveness/claude`, {
    method: "POST", headers: { ...remoteHeaders, "Content-Type": "application/json", ...(host ? { "X-Dash-Host": host } : {}), ...extra }, body: JSON.stringify(body),
  });
  for (const host of [undefined, "bad host", "a".repeat(65)]) expect(await (await push(host, [])).text()).toBe("{}");
  await push("mbp", { foo: 1 });
  await push(local, []);
  expect(app.malformedCount).toBe(4);
  expect(app.rejectedCount).toBe(1);
  expect(app.db.getSession(localKey)?.alive).toBe(true);
  const plain = await fetch(`${tailnetBase}/ingest/liveness/claude`, { method: "POST", headers: { ...remoteHeaders, "Content-Type": "text/plain", "X-Dash-Host": "mbp" }, body: "[]" });
  expect(await plain.text()).toBe("{}");
  expect(app.rejectedCount).toBe(2);
  const response = await push("mbp", [{ sessionId: "blocked", pid: 10 }], { "X-Forwarded-For": "1.2.3.4" });
  expect(await response.text()).toBe("{}");
  expect(app.rejectedCount).toBe(3);
  expect(app.db.getSession("mbp|claude|blocked")).toBeNull();
});

test("authoritative remote absence ends a session without a PID after two minutes", async () => {
  let clock = 1_000_000;
  startTailnet(() => clock);
  const push = (body: unknown) => fetch(`${tailnetBase}/ingest/liveness/claude`, {
    method: "POST", headers: { ...remoteHeaders, "Content-Type": "application/json", "X-Dash-Host": "mbp" }, body: JSON.stringify(body),
  });
  await push([{ sessionId: "no-pid", status: "busy" }]);
  clock += 1_000;
  await push([]);
  expect(app.db.getSession("mbp|claude|no-pid")).toMatchObject({ alive: false, status: "working" });
  clock += 120_000;
  await push([]);
  expect(app.db.getSession("mbp|claude|no-pid")?.status).toBe("ended");
});

test("local liveness backfill guard skips remote DTOs", async () => {
  app.close();
  app = createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false,
    pollClaude: async () => [], pollOmp: async () => null });
  const remote = app.db.markLiveness("claude", [{ host: "mbp", harness: "claude", sessionId: "s1", pid: 10 }], "mbp", Date.now(), () => false)[0];
  app.db.markLiveness = (() => [remote]) as typeof app.db.markLiveness;
  let checked = false;
  app.db.hasResponses = (() => { checked = true; return false; }) as typeof app.db.hasResponses;
  await app.runLiveness();
  expect(checked).toBe(false);
});

test("SSE publishes a session event within one second of ingest", async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("text/event-stream");
  const stream = new SseReader(response.body!.getReader());
  try {
    expect(await stream.nextFrame()).toBe(": connected");
    const start = performance.now();
    await ingest(payload("SessionStart"));
    const next = await Promise.race([
      stream.nextEvent("session"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 1000)),
    ]);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(next).toMatchObject({ key, status: "your_turn" });
  } finally {
    await stream.close();
    controller.abort();
  }
});

test("SSE stays connected beyond Bun's default idle timeout and sends a heartbeat", async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/stream`, {signal:controller.signal});
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let heartbeat = false;
  const deadline = Date.now() + 13_000;
  try {
    while (Date.now() < deadline) {
      const wait = deadline - Date.now();
      const result = await Promise.race([reader.read(), new Promise<null>(resolve => setTimeout(() => resolve(null), wait))]);
      if (!result) break;
      expect(result.done).toBe(false);
      if (decoder.decode(result.value).includes(": heartbeat")) heartbeat = true;
    }
    expect(heartbeat).toBe(true);
    expect(response.body?.locked).toBe(true);
  } finally {
    await reader.cancel();
    controller.abort();
  }
}, 14_500);

test("identical liveness polls publish one changed session DTO", async () => {
  app.close();
  const sessionId = "synthetic-live";
  const host = localHost();
  app = createDashServer({port:0,dataPath:":memory:",backfill:false,liveness:false,
    pollClaude:async () => [{host,harness:"claude",sessionId,pid:12345,name:"Synthetic",detail:"busy"}],
    pollOmp:async () => null});
  base = `http://127.0.0.1:${app.server.port}`;
  await fetch(`${base}/ingest/claude`, {method:"POST",headers:{...headers,"X-Dash-Host":host},body:JSON.stringify({hook_event_name:"Stop",session_id:sessionId,last_assistant_message:"synthetic response"})});
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/stream`,{signal:controller.signal});
  const events = new SseReader(stream.body!.getReader());
  try {
    await events.nextFrame();
    await app.runLiveness();
    expect(await events.nextEvent("session")).toMatchObject({ sessionId });
    await app.runLiveness();
    const second = await Promise.race([events.nextEvent("session").then(() => "event"), new Promise<string>(resolve => setTimeout(() => resolve("quiet"), 250))]);
    expect(second).toBe("quiet");
    expect((app.db.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE kind='liveness'").get() as any).n).toBe(1);
  } finally { await events.close(); controller.abort(); }
});

test("page responses send the strict content security policy", async () => {
  await ingest(payload("Stop", { last_assistant_message: '<img src=x onerror=alert(1)><script>alert(1)</script> ![x](https://invalid.example/image)' }));
  const response = await fetch(base);
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
});


describe("project rules API", () => {

  test("is hidden when disabled; enabled saves and previews rules and broadcasts refreshed projects", async () => {
    await ingest(payload("SessionStart"));
    expect((await getJson("/api/sessions")).sessions[0].project).toBe("project");
    expect((await fetch(`${base}/api/projects/rules`)).status).toBe(404);
    for (const [path, body] of [["/api/projects/rules", { rules: [] }], ["/api/projects/preview", { cwd: "/tmp/example" }]] as const) {
      const blocked = await fetch(`${base}${path}`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(blocked.status).toBe(404);
      expect(await blocked.text()).toBe('{"error":"not found"}');
    }

    enableTopics();
    await ingest(payload("SessionStart", { cwd: "/projects/alpha/build" }));
    expect((await getJson("/api/sessions")).sessions[0].project).toBe("alpha");

    const controller = new AbortController();
    const stream = await fetch(`${base}/api/stream`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
      const preview = await projectPost("/api/projects/preview", {
        cwd: "/unsaved/Preview", rules: [{ pattern: "/unsaved/([^/]+)", project: "$1" }],
      });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toEqual({ project: "Preview", errors: [] });

      const saved = await projectPost("/api/projects/rules", {
        rules: [{ pattern: "^/projects/([a-z]+)/", project: "custom-$1" }],
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ rules: [{ pattern: "^/projects/([a-z]+)/", project: "custom-$1" }], errors: [] });
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE project refresh timeout")), 1000)),
      ]);
      const eventData = new TextDecoder().decode(next.value).match(/^data: (.*)$/m)?.[1];
      expect(JSON.parse(eventData!)).toMatchObject({ key, project: "custom-alpha" });
      expect((await getJson("/api/sessions")).sessions[0].project).toBe("custom-alpha");
      expect((await projectPost("/api/projects/rules", {
        rules: [{ pattern: "^/projects/([a-z]+)/", project: "custom-$1" }],
      })).status).toBe(200);
      const forced = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE forced refresh timeout")), 1000)),
      ]);
      expect(JSON.parse(new TextDecoder().decode(forced.value).match(/^data: (.*)$/m)![1])).toMatchObject({ key, project: "custom-alpha" });
    } finally {
      await reader.cancel();
      controller.abort();
    }
  });

  test("new POST routes require an allowed Origin and JSON on loopback and tailnet", async () => {
    enableTopics();
    const cases = [
      ["/api/projects/rules", { rules: [] }],
      ["/api/projects/preview", { cwd: "/tmp/example" }],
    ] as const;
    for (const [path, body] of cases) {
      expect((await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(403);
      expect((await projectPost(path, body, "http://foreign.example")).status).toBe(403);
      expect((await fetch(`${base}${path}`, { method: "POST", headers: { Origin: base }, body: "{}" })).status).toBe(415);
      expect((await fetch(`${base}${path}`, { method: "POST", headers: { Origin: base, "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
      expect((await projectPost(path, body)).status).toBe(200);
    }
    const options = await fetch(`${base}/api/projects/rules`, { method: "OPTIONS", headers: { Origin: base } });
    expect(options.status).toBe(404);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();

    startTailnet();
    for (const [path, body] of cases) {
      const response = await fetch(`${tailnetBase}${path}`, {
        method: "POST", headers: { ...remoteHeaders, Origin: "https://dash.tailnet.test", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }
  });

  test("every browser API write checks Origin and JSON before reaching its route", async () => {
    enableActionRoutes();
    await ingest(payload("Stop", { last_assistant_message: "synthetic response for API writes" }));
    app.db.setSetting("telegram.chat_id", "synthetic-chat");
    app.db.setSetting("telegram.user_id", "12345");
    const previousHome = process.env.HOME;
    const scratchHome = mkdtempSync(join(tmpdir(), "dash-api-backfill-home-"));
    process.env.HOME = scratchHome;
    const encodedKey = encodeURIComponent(key);
    const cases: { name: string; path: string; body: unknown }[] = [
      { name: "project rules", path: "/api/projects/rules", body: { rules: [] } },
      { name: "project preview", path: "/api/projects/preview", body: { cwd: "/tmp/synthetic" } },
      { name: "Telegram unpair", path: "/api/telegram/unpair", body: {} },
      { name: "mark session seen", path: `/api/sessions/${encodedKey}/seen`, body: {} },
      { name: "mark all sessions seen", path: "/api/seen-all", body: {} },
      { name: "backfill", path: "/api/backfill", body: {} },
      { name: "submit web reply", path: `/api/sessions/${encodedKey}/reply`, body: { text: "synthetic owner reply" } },
      { name: "cancel session replies", path: `/api/sessions/${encodedKey}/replies/cancel`, body: {} },
    ];
    const snapshot = () => ({
      rules: app.db.getSetting("projects.rules"),
      sessions: app.db.listSessions(true, true),
      replies: app.db.sqlite.query("SELECT id, state FROM replies ORDER BY id").all(),
      settings: app.db.sqlite.query("SELECT k, v FROM settings ORDER BY k").all(),
    });
    const send = (path: string, body: unknown, origin: string | undefined, contentType: string | undefined) => fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...(origin === undefined ? {} : { Origin: origin }), ...(contentType === undefined ? {} : { "Content-Type": contentType }) },
      ...(contentType === undefined ? {} : { body: JSON.stringify(body) }),
    });

    try {
      for (const route of cases) {
        const before = snapshot();
        for (const origin of [undefined, "http://foreign.example", "null", "malformed-origin"]) {
          const response = await send(route.path, route.body, origin, "application/json");
          expect(response.status).toBe(403);
          expect(await response.text()).toBe('{"error":"forbidden"}');
          expect(snapshot()).toEqual(before);
        }
        for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=synthetic"]) {
          const response = await send(route.path, route.body, base, contentType);
          expect(response.status).toBe(415);
          expect(await response.text()).toBe('{"error":"unsupported media type"}');
          expect(snapshot()).toEqual(before);
        }
        const accepted = await send(route.path, route.body, base, "Application/JSON; charset=UTF-8");
        expect(accepted.status).toBe(200);
        expect(accepted.headers.get("access-control-allow-origin")).toBeNull();
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      rmSync(scratchHome, { recursive: true, force: true });
    }
  });

  test("rejects malformed saves and oversized preview paths without changing rules", async () => {
    enableTopics();
    const before = app.db.getSetting("projects.rules");
    const sendRaw = (path: string, body: string) => fetch(`${base}${path}`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body,
    });
    for (const body of ["{", JSON.stringify({ rules: Array.from({ length: 33 }, (_, i) => ({ pattern: `^/${i}$`, project: String(i) })) }),
      JSON.stringify({ rules: [{ pattern: "(", project: "invalid" }] })]) {
      const response = await sendRaw("/api/projects/rules", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid rules" });
      expect(app.db.getSetting("projects.rules")).toBe(before);
    }
    const badPath = await projectPost("/api/projects/preview", { cwd: "x".repeat(4097) });
    expect(badPath.status).toBe(400);
    expect(app.db.getSetting("projects.rules")).toBe(before);
  });

  test("surfaces cached stored-rule errors and skips invalid regexes safely", async () => {
    enableTopics();
    await ingest(payload("SessionStart", { cwd: "/preview/kept" }));
    const invalidRegexRules = [
      { pattern: "(", project: "broken" },
      { pattern: "^/preview/([^/]+)$", project: "$1" },
    ];
    app.db.setSetting("projects.rules", JSON.stringify(invalidRegexRules));
    expect(await getJson("/api/projects/rules")).toEqual({
      rules: invalidRegexRules, errors: [{ index: 0, error: "invalid regex" }],
    });
    const preview = await projectPost("/api/projects/preview", { cwd: "/preview/kept" });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ project: "kept", errors: [{ index: 0, error: "invalid regex" }] });
    const { sessions } = await getJson("/api/sessions");
    expect(sessions[0].project).toBe("kept");

    app.db.setSetting("projects.rules", "{");
    expect((await getJson("/api/projects/rules")).errors).toEqual([{ index: -1, error: "invalid JSON" }]);
    expect((await getJson("/api/sessions")).sessions[0].project).toBe("kept");

    app.db.setSetting("projects.rules", JSON.stringify({ pattern: "/tmp", project: "wrong shape" }));
    expect((await getJson("/api/projects/rules")).errors).toEqual([{ index: -1, error: "invalid rules" }]);
  });
});

test("a StopFailure event urgently pages once even when its DTO was already deduped", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "dash-step4a-server-"));
  const dataPath = join(scratch, "dash.sqlite");
  const stamp = 1_000_000;
  const cwd = "/projects/invest/run";
  const seeded = new DashDB(dataPath, { topicsEnabled: true });
  seeded.setSetting("telegram.chat_id", "812345");
  seeded.setSetting("telegram.user_id", "712345");
  seeded.setSetting("telegram.topics", JSON.stringify({ groupChatId: "-100812345", topics: { general: null, urgent: 90 } }));
  seeded.applyEvent({ host: "synthetic-host", harness: "claude", sessionId, kind: "error", ts: stamp,
    cwd, text: "Synthetic crash", interactive: true });
  seeded.close();

  const bot = new FakeBot();
  app.close();
  process.env.DASH_TG_TOPICS = "1";
  process.env.DASH_TELEGRAM = "1";
  app = createDashServer({ port: 0, dataPath, backfill: false, liveness: false, now: () => stamp,
    telegram: { apiBase: bot.base, readToken: async () => fakeBotToken, sleep: async ms => Bun.sleep(Math.min(ms, 10)) } });
  base = `http://127.0.0.1:${app.server.port}`;
  try {
    for (let i = 0; i < 100 && app.db.countSessions() === 0; i++) await Bun.sleep(1);
    for (let i = 0; i < 100 && (await getJson("/healthz")).telegram.state !== "ok"; i++) await Bun.sleep(1);
    expect((await getJson("/healthz")).telegram.state).toBe("ok");
    await fetch(`${base}/api/seen-all`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" } });
    expect(bot.calls.filter(call => call.method === "sendMessage")).toHaveLength(0);

    await ingest(payload("StopFailure", { cwd, last_assistant_message: "Synthetic crash" }));
    for (let i = 0; i < 100 && !bot.calls.some(call => call.method === "sendMessage"); i++) await Bun.sleep(1);
    const sends = bot.calls.filter(call => call.method === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0].body).toMatchObject({ chat_id: "-100812345", message_thread_id: 90 });
  } finally {
    app.close();
    bot.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("Luna extraction wiring", () => {
  const ask = "Should the cache use postgres or sqlite? Both work; sqlite is simpler and I'd go with sqlite.";
  const luna = { decisions: [{ title: "Should the cache use postgres or sqlite", options: [{ key: "A", label: "postgres" }, { key: "B", label: "sqlite" }],
    recIndex: 1, recQuote: "I'd go with sqlite" }] };
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "dash-extract-"));
    // Fake codex: logs argv/stdin per call and writes out.json to --output-last-message; `hold` waits for a release file.
    writeFileSync(join(scratch, "codex"), `#!/bin/sh
F='${scratch}'
printf '%s\\n' "$@" > "$F/argv"; cat > "$F/stdin"; echo call >> "$F/calls"
out=""; prev=""
for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done
case "$(cat "$F/mode")" in
  ok) cp "$F/out.json" "$out" ;;
  hold) i=0; while [ ! -f "$F/release" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; cp "$F/out.json" "$out" ;;
  fail) exit 3 ;;
esac
`);
    chmodSync(join(scratch, "codex"), 0o755);
    writeFileSync(join(scratch, "mode"), "ok");
    writeFileSync(join(scratch, "out.json"), JSON.stringify(luna));
  });
  afterEach(() => { app.close(); rmSync(scratch, { recursive: true, force: true }); });

  function start(judge: boolean, dataPath = ":memory:") {
    app.close();
    process.env.DASH_REPLIES = "1";
    process.env.DASH_JUDGE = judge ? "1" : "";
    process.env.DASH_CODEX_BIN = join(scratch, "codex");
    app = createDashServer({ port: 0, dataPath, backfill: false, liveness: false, judge: { dataDir: join(scratch, "data") } });
    base = `http://127.0.0.1:${app.server.port}`;
  }
  const calls = () => existsSync(join(scratch, "calls")) ? readFileSync(join(scratch, "calls"), "utf8").trim().split("\n").length : 0;
  const rows = () => app.db.sqlite.query("SELECT id,decision_state AS state,turn_seq AS turn FROM responses ORDER BY id").all() as any[];
  async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
    const deadline = Date.now() + ms;
    while (!(await check())) { if (Date.now() > deadline) throw new Error("timed out"); await Bun.sleep(10); }
  }
  async function sse() {
    const controller = new AbortController();
    const reader = (await fetch(`${base}/api/stream`, { signal: controller.signal })).body!.getReader();
    await reader.read();
    const frames: any[] = [];
    void (async () => {
      const decoder = new TextDecoder();
      try { for (let r = await reader.read(); !r.done; r = await reader.read()) {
        for (const m of decoder.decode(r.value).matchAll(/^event: session\ndata: (.*)$/gm)) frames.push(JSON.parse(m[1]));
      } } catch {}
    })();
    return { frames, close: () => { void reader.cancel().catch(() => {}); controller.abort(); } };
  }

  test("a current-turn Luna result reaches /api/sessions, /api/timeline and a session SSE frame", async () => {
    start(true);
    const stream = await sse();
    try {
      await ingest(payload("Stop", { last_assistant_message: ask }));
      await until(() => rows()[0]?.state === "luna");
      const expected = { decisions: [{ ...luna.decisions[0] }], source: "luna" };
      const session = (await getJson("/api/sessions")).sessions[0];
      expect(session.lastResponses[0]).toMatchObject({ decisionState: "luna", turnSeq: session.turnSeq, decisions: expected });
      expect((await getJson("/api/timeline")).responses[0]).toMatchObject({ decisionState: "luna", decisions: expected });
      await until(() => stream.frames.some(f => f.lastResponses[0]?.decisionState === "luna"));
      expect(stream.frames.map(f => f.lastResponses[0]?.decisionState)).toEqual(["pending", "luna"]);
      expect(calls()).toBe(1);
      const argv = readFileSync(join(scratch, "argv"), "utf8");
      expect(argv).toContain("--ignore-user-config\n");
      expect(argv).toContain(`--output-schema\n${join(scratch, "data", "judge")}`);
      const stdin = readFileSync(join(scratch, "stdin"), "utf8");
      expect(stdin).toMatch(/^Extract only decisions,[^]*<untrusted_response nonce="([0-9a-f]{32})">\nShould the cache[^]*\n<\/untrusted_response nonce="\1">\n$/);
      expect(readdirSync(join(scratch, "data", "judge"))).toEqual([]);
    } finally { stream.close(); }
  });

  test("a result that lands after the turn moved persists historically without a current SSE refresh", async () => {
    writeFileSync(join(scratch, "mode"), "hold");
    start(true);
    await ingest(payload("Stop", { last_assistant_message: ask }));
    await until(() => existsSync(join(scratch, "stdin")));
    await ingest(payload("Stop", { last_assistant_message: "Synthetic follow-up: done." }));
    expect(rows().map(r => [r.state, r.turn])).toEqual([["pending", 1], ["none", 2]]);
    const stream = await sse();
    try {
      writeFileSync(join(scratch, "release"), "");
      await until(() => rows()[0].state === "luna");
      await Bun.sleep(150);
      expect(stream.frames).toEqual([]);
      const timeline = (await getJson("/api/timeline")).responses;
      expect(timeline.map((r: any) => [r.decisionState, r.turnSeq])).toEqual([["none", 2], ["luna", 1]]);
    } finally { stream.close(); }
  });

  test("a judge failure stores failed with empty decisions and never becomes an error event", async () => {
    writeFileSync(join(scratch, "mode"), "fail");
    start(true);
    await ingest(payload("Stop", { last_assistant_message: ask }));
    await until(() => rows()[0]?.state === "failed");
    const session = (await getJson("/api/sessions")).sessions[0];
    expect(session).toMatchObject({ status: "your_turn", lastResponses: [{ decisionState: "failed", decisions: { decisions: [], source: "parser" } }] });
    expect(session.lastError).toBeUndefined();
    expect(app.db.sqlite.query("SELECT COUNT(*) AS n FROM events WHERE kind='error'").get()).toEqual({ n: 0 });
  });

  test("invented Luna options are rejected and the row settles failed", async () => {
    writeFileSync(join(scratch, "out.json"), JSON.stringify({ decisions: [{ title: "Synthetic invented", options: [{ key: "A", label: "zzzz" }, { key: "B", label: "yyyy" }], recIndex: null, recQuote: null }] }));
    start(true);
    await ingest(payload("Stop", { last_assistant_message: ask }));
    await until(() => rows()[0]?.state === "failed");
    expect(app.db.getResponse(rows()[0].id)!.decisions).toEqual({ decisions: [], source: "parser" });
  });

  test("with DASH_JUDGE unset a decision-like response is stored none and the fake codex never runs", async () => {
    start(false);
    await ingest(payload("Stop", { last_assistant_message: ask }));
    await Bun.sleep(100);
    expect(rows().map(r => r.state)).toEqual(["none"]);
    expect(existsSync(join(scratch, "calls"))).toBe(false);
    expect(existsSync(join(scratch, "data"))).toBe(false);
  });

  test("startup resumes a current pending row once and settles a moved one as none", async () => {
    const dataPath = join(scratch, "dash.sqlite");
    const seeded = new DashDB(dataPath, { decisionsEnabled: true, judgeEnabled: true });
    const event = { host: "synthetic-host", harness: "claude" as const, sessionId, kind: "response" as const, interactive: true };
    seeded.applyEvent({ ...event, ts: Date.now(), text: ask });
    seeded.applyEvent({ ...event, sessionId: "synthetic-moved", ts: Date.now(), text: ask });
    seeded.applyEvent({ ...event, sessionId: "synthetic-moved", kind: "error", ts: Date.now(), text: "Synthetic crash" });
    seeded.close();
    start(true, dataPath);
    await until(() => rows().every(r => r.state !== "pending"));
    expect(rows().map(r => r.state)).toEqual(["luna", "none"]);
    expect(calls()).toBe(1);
  });

  test("malformed stored decisions_json surfaces null in both APIs", async () => {
    start(false);
    await ingest(payload("Stop", { last_assistant_message: ask }));
    app.db.sqlite.query("UPDATE responses SET decisions_json='{bad'").run();
    const sessions = await fetch(`${base}/api/sessions`), timeline = await fetch(`${base}/api/timeline`);
    expect([sessions.status, timeline.status]).toEqual([200, 200]);
    expect((await sessions.json() as any).sessions[0].lastResponses[0].decisions).toBeNull();
    expect((await timeline.json() as any).responses[0].decisions).toBeNull();
  });
});

describe("session identity", () => {
  const identityPath = `/api/sessions/${encodeURIComponent(key)}/identity`;

  test("owner identity survives source updates and liveness without changing routing or activity", async () => {
    await fetch(`${base}/ingest/claude`, { method: "POST",
      headers: { ...headers, "X-Dash-Account-Alias": "claude-work" }, body: payload("Stop", { last_assistant_message: "Review ready." }) });
    const before = app.db.getSession(key)!;
    const saved = await projectPost(identityPath, { displayName: "Pricing review", accountAlias: "work-main" });
    expect(saved.status).toBe(200);
    expect((await saved.json()).session).toMatchObject({
      key, host: "synthetic-host", harness: "claude", sessionId, displayName: "Pricing review",
      accountAlias: "work-main", reportedAccountAlias: "claude-work", lastActivity: before.lastActivity, turnSeq: before.turnSeq,
    });
    await fetch(`${base}/ingest/claude`, { method: "POST",
      headers: { ...headers, "X-Dash-Account-Alias": "new-source" }, body: payload("UserPromptSubmit", { prompt: "Continue reviewing." }) });
    app.db.markLiveness("claude", [{ sessionId, host: "synthetic-host", harness: "claude", name: "Source name", cwd: "/synthetic/project", pid: 123, detail: "working" }], "synthetic-host");
    expect(app.db.getSession(key)).toMatchObject({ displayName: "Pricing review", accountAlias: "work-main", reportedAccountAlias: "new-source" });
    expect((await getJson("/api/timeline")).responses[0]).toMatchObject({ displayName: "Pricing review", accountAlias: "work-main" });
    await projectPost(identityPath, { displayName: null, accountAlias: "" });
    await ingest(payload("Stop", { last_assistant_message: "Another result." }));
    expect(app.db.getSession(key)).toMatchObject({ displayName: "Source name", accountAlias: "" });
    await projectPost(identityPath, { displayName: null, accountAlias: null });
    expect(app.db.getSession(key)).toMatchObject({ displayName: "Source name", accountAlias: "new-source" });
  });

  test("identity edits retain write gates and reject invalid metadata atomically", async () => {
    await ingest(payload("SessionStart"));
    const values = { displayName: "Owner label", accountAlias: "work" };
    expect((await fetch(`${base}${identityPath}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) })).status).toBe(403);
    expect((await projectPost(identityPath, values, "https://foreign.test")).status).toBe(403);
    expect((await projectPost(identityPath, values, base, { "Content-Type": "text/plain" })).status).toBe(415);
    for (const invalid of [
      { ...values, accountAlias: "a".repeat(65) }, { ...values, accountAlias: "owner@example.test" },
      { ...values, displayName: "line\nbreak" }, { ...values, displayName: "a".repeat(129) },
      { ...values, host: "another-machine" }, { displayName: "missing alias" }, [],
    ]) expect((await projectPost(identityPath, invalid)).status).toBe(400);
    expect(app.db.getSession(key)?.displayNameOverride).toBeUndefined();
    expect((await projectPost("/api/sessions/missing/identity", values)).status).toBe(404);
    startTailnet();
    const denied = await fetch(`${tailnetBase}${identityPath}`, { method: "POST",
      headers: { Host: "dash.tailnet.test", "X-Forwarded-For": "100.1.2.3", Origin: "https://dash.tailnet.test", "Content-Type": "application/json" },
      body: JSON.stringify(values) });
    expect(denied.status).toBe(403);
  });

  test("different account labels never merge sessions or retarget queued replies", async () => {
    enableActionRoutes();
    for (const [id, alias] of [["account-one", "work"], ["account-two", "personal"]]) {
      await fetch(`${base}/ingest/omp`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "same-machine", harness: "omp", sessionId: id, interactive: true, kind: "response", text: `Output for ${id}`, accountAlias: alias }) });
    }
    const one = "same-machine|omp|account-one", two = "same-machine|omp|account-two";
    await projectPost(`/api/sessions/${encodeURIComponent(one)}/identity`, { displayName: "Review", accountAlias: "personal" });
    expect((await projectPost(`/api/sessions/${encodeURIComponent(one)}/reply`, { text: "Only the first session should receive this." })).status).toBe(200);
    expect(app.db.getReplies(one)[0]?.state).toBe("queued");
    expect(app.db.getReplies(two)).toEqual([]);
    expect(app.db.listSessions().map(s => s.key).sort()).toEqual([one, two].sort());
    expect(app.db.getSession(two)?.displayNameOverride).toBeUndefined();
  });

  test("identity persists across collector restarts and legacy source events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-identity-")), dataPath = join(dir, "dash.sqlite");
    try {
      app.close();
      app = createDashServer({ port: 0, dataPath, backfill: false, liveness: false });
      base = `http://127.0.0.1:${app.server.port}`;
      await ingest(payload("SessionStart"));
      expect(app.db.getSession(key)?.accountAlias).toBeUndefined();
      await projectPost(identityPath, { displayName: "Persisted name", accountAlias: "personal" });
      app.close();
      app = createDashServer({ port: 0, dataPath, backfill: false, liveness: false });
      base = `http://127.0.0.1:${app.server.port}`;
      await ingest(payload("Stop", { last_assistant_message: "Legacy sender still works." }));
      expect(app.db.getSession(key)).toMatchObject({ displayName: "Persisted name", accountAlias: "personal" });
    } finally { app.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
test("source inventory deduplicates configured labels without exposing bare peer addresses", async () => {
  startTailnet(() => 55_000, "source-peer=192.0.2.51,source-peer=192.0.2.52,192.0.2.53");
  app.db.recordSourceReport("future-peer", 55_001, true);
  app.db.recordSourceReport("future-peer", 55_000);
  const inventory = await getJson("/api/sources") as SourceInventoryForTest;
  expect(inventory.generatedAt).toBe(55_000);
  expect(inventory.staleAfterMs).toBe(120_000);
  expect(inventory.unlabelledPeerEntries).toBe(1);
  expect(inventory.sources.filter(source => source.host === "source-peer")).toHaveLength(1);
  expect(inventory.sources.find(source => source.host === "source-peer")).toMatchObject({
    configured: true, status: "unreported", lastReportAt: null, lastHeartbeatAt: null, accounts: [],
  });
  expect(inventory.sources.some(source => source.host.startsWith("100."))).toBe(false);
  expect(inventory.sources.some(source => source.host === localHost())).toBe(true);
  expect(inventory.sources.find(source => source.host === "future-peer")).toMatchObject({
    status: "unknown", lastReportAt: 55_000, lastHeartbeatAt: 55_001,
  });
  const hosts = inventory.sources.map(source => source.host);
  expect(hosts).toEqual([...hosts].sort());
});

test("source inventory groups unassigned sessions and exposes metadata, not retained output", async () => {
  const send = (id: string, hook: string, extra: Record<string, unknown> = {}, alias?: string) =>
    fetch(`${base}/ingest/claude`, { method: "POST",
      headers: { ...headers, ...(alias ? { "X-Dash-Account-Alias": alias } : {}) },
      body: payload(hook, { session_id: id, cwd: "/synthetic/project", ...extra }) });
  await send("unassigned-session", "SessionStart", { credential: "not-for-inventory" });
  await send("unassigned-session", "Stop", { last_assistant_message: "private retained output" });
  await send("assigned-session", "SessionStart", {}, " Work ");
  const inventory = await getJson("/api/sources") as SourceInventoryForTest;
  const source = inventory.sources.find(entry => entry.host === "synthetic-host");
  expect(source).toMatchObject({
    configured: false, status: "reporting", lastHeartbeatAt: null,
    accounts: [
      { accountAlias: null, sessions: [expect.objectContaining({ key: "synthetic-host|claude|unassigned-session", harness: "claude", interactive: true })] },
      { accountAlias: "Work", sessions: [expect.objectContaining({ key: "synthetic-host|claude|assigned-session", harness: "claude" })] },
    ],
  });
  expect(JSON.stringify(source)).not.toContain("private retained output");
  expect(JSON.stringify(source)).not.toContain("not-for-inventory");
});

test("empty remote heartbeats recover stale inventory while malformed reports never refresh or end sessions", async () => {
  let clock = 1_000_000;
  startTailnet(() => clock);
  const remoteKey = "mbp|claude|inventory-session";
  const push = (body: unknown, forwarded = remoteHeaders["X-Forwarded-For"]) => fetch(`${tailnetBase}/ingest/liveness/claude`, {
    method: "POST", headers: { ...remoteHeaders, "X-Forwarded-For": forwarded, "Content-Type": "application/json", "X-Dash-Host": "mbp" }, body: JSON.stringify(body),
  });
  const record = { sessionId: "inventory-session", pid: 10, status: "idle" };
  await push([record]);
  let inventory = await getJson("/api/sources") as SourceInventoryForTest;
  let source = inventory.sources.find(entry => entry.host === "mbp");
  expect(source).toMatchObject({ status: "reporting", lastReportAt: clock, lastHeartbeatAt: clock });
  clock += 1_000;
  await push([]);
  expect(app.db.getSession(remoteKey)).toMatchObject({ alive: false, status: "your_turn" });
  clock += 120_001;
  inventory = await getJson("/api/sources") as SourceInventoryForTest;
  source = inventory.sources.find(entry => entry.host === "mbp");
  expect(source).toMatchObject({ status: "stale", lastReportAt: 1_001_000, lastHeartbeatAt: 1_001_000 });
  expect(app.db.getSession(remoteKey)?.status).toBe("your_turn");
  await push({ invalid: true });
  expect(app.malformedCount).toBe(1);
  inventory = await getJson("/api/sources") as SourceInventoryForTest;
  source = inventory.sources.find(entry => entry.host === "mbp");
  expect(source).toMatchObject({ status: "stale", lastReportAt: 1_001_000, lastHeartbeatAt: 1_001_000 });
  expect(app.db.getSession(remoteKey)?.status).toBe("your_turn");
  const forged = await push([], "1.2.3.4");
  expect(forged.status).toBe(200);
  expect(await forged.text()).toBe("{}");
  expect(app.rejectedCount).toBe(1);
  inventory = await getJson("/api/sources") as SourceInventoryForTest;
  source = inventory.sources.find(entry => entry.host === "mbp");
  expect(source).toMatchObject({ status: "stale", lastReportAt: 1_001_000, lastHeartbeatAt: 1_001_000 });
  clock += 1;
  await push([]);
  inventory = await getJson("/api/sources") as SourceInventoryForTest;
  source = inventory.sources.find(entry => entry.host === "mbp");
  expect(source).toMatchObject({ status: "reporting", lastReportAt: clock, lastHeartbeatAt: clock });
  expect(app.db.getSession(remoteKey)?.status).toBe("ended");
});

test("successful empty local polls record receipts while unsupported or failed OMP polls do not", async () => {
  let clock = 3_000_000;
  let claudeFails = false;
  let ompResult: "empty" | "null" | "error" = "null";
  app.close();
  app = createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false, now: () => clock,
    pollClaude: async () => { if (claudeFails) throw new Error("poll failed"); return []; },
    pollOmp: async () => { if (ompResult === "error") throw new Error("poll failed"); return ompResult === "empty" ? [] : null; } });
  base = `http://127.0.0.1:${app.server.port}`;
  await app.runLiveness();
  let inventory = await getJson("/api/sources") as SourceInventoryForTest;
  let source = inventory.sources.find(entry => entry.host === localHost());
  expect(source).toMatchObject({ status: "reporting", lastReportAt: clock, lastHeartbeatAt: clock });
  clock += 5_000;
  claudeFails = true;
  ompResult = "empty";
  await app.runLiveness();
  inventory = await getJson("/api/sources") as SourceInventoryForTest;
  source = inventory.sources.find(entry => entry.host === localHost());
  expect(source).toMatchObject({ status: "reporting", lastReportAt: clock, lastHeartbeatAt: clock });
  const ompReceipt = { lastReportAt: clock, lastHeartbeatAt: clock };
  clock += 5_000;
  ompResult = "null";
  await app.runLiveness();
  inventory = await getJson("/api/sources") as SourceInventoryForTest;
  source = inventory.sources.find(entry => entry.host === localHost());
  expect(source).toMatchObject({ status: "reporting", ...ompReceipt });
  clock += 5_000;
  ompResult = "error";
  await app.runLiveness();
  inventory = await getJson("/api/sources") as SourceInventoryForTest;
  source = inventory.sources.find(entry => entry.host === localHost());
  expect(source).toMatchObject({ status: "reporting", ...ompReceipt });
});

test("source report receipt timestamps survive database restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-source-report-"));
  const dataPath = join(dir, "dash.sqlite");
  const first = new DashDB(dataPath);
  try { first.recordSourceReport("persisted-peer", 42_000, true); }
  finally { first.close(); }
  const reopened = new DashDB(dataPath);
  try {
    expect(reopened.sourceReports()).toEqual([{ host: "persisted-peer", lastReportAt: 42_000, lastHeartbeatAt: 42_000 }]);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an empty heartbeat notifies inventory subscribers without a session event", async () => {
  const clock = 7_000_000;
  startTailnet(() => clock, "source-peer=192.0.2.10");
  expect((await getJson("/api/sources")).sources.find((source: { host: string }) => source.host === "source-peer").status).toBe("unreported");
  const stream = new SseReader((await fetch(`${base}/api/stream`)).body!.getReader());
  try {
    expect(await stream.nextFrame()).toBe(": connected");
    await fetch(`${tailnetBase}/ingest/liveness/claude`, {
      method: "POST",
      headers: { ...remoteHeaders, "Content-Type": "application/json", "X-Dash-Host": "source-peer" },
      body: "[]",
    });
    await Promise.race([
      stream.nextEvent("sources"),
      Bun.sleep(1_000).then(() => { throw new Error("timed out waiting for inventory refresh"); }),
    ]);
    const inventory = await getJson("/api/sources") as SourceInventoryForTest;
    expect(inventory.sources.find(source => source.host === "source-peer")).toMatchObject({
      status: "reporting", lastReportAt: clock, lastHeartbeatAt: clock, accounts: [],
    });
    expect((await getJson("/api/sessions")).sessions).toEqual([]);
  } finally { await stream.close(); }
});

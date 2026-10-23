import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runs the whole dashboard script against a permissive stub DOM, so a helper that is out of scope for its
// caller (the AXI-448 port left the project-filter helpers inside loadSessions) fails here, not in the browser.
// Every stubbed property is another stub; fetch never settles, so only the synchronous init path runs.
function stub(): any {
  const target = function () {};
  return new Proxy(target, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === Symbol.iterator) return function* () {};
      if (key === "then") return undefined;
      if (key === "length" || key === "size") return 0;
      return stub();
    },
    set: () => true,
    apply: () => stub(),
    construct: () => stub(),
  });
}

test("app.js initialises without a synchronous error", () => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  const globals = ["document", "window", "localStorage", "sessionStorage", "navigator", "location", "history", "EventSource",
    "Notification", "Option", "marked", "DOMPurify", "matchMedia", "requestAnimationFrame", "setTimeout", "setInterval",
    "clearTimeout", "clearInterval", "addEventListener", "getComputedStyle", "ResizeObserver", "performance", "scrollTo",
    "innerHeight", "confirm", "alert"];
  const never = () => new Promise(() => {});
  const run = new Function(...globals, "fetch", script);
  expect(() => run(...globals.map(() => stub()), never)).not.toThrow();
});

test("project rules are fetched only when Telegram topics are enabled", async () => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  const globals = ["document", "window", "localStorage", "sessionStorage", "navigator", "location", "history", "EventSource",
    "Notification", "Option", "marked", "DOMPurify", "matchMedia", "requestAnimationFrame", "setTimeout", "setInterval",
    "clearTimeout", "clearInterval", "addEventListener", "getComputedStyle", "ResizeObserver", "performance", "scrollTo",
    "innerHeight", "confirm", "alert"];
  const run = new Function(...globals, "fetch", script);
  for (const topicsEnabled of [false, true]) {
    const calls: string[] = [];
    const fetcher = (path: string) => {
      calls.push(path);
      if (path === "/api/telegram") return Promise.resolve({
        ok: true, json: async () => ({ topicsEnabled, state: "disabled", mode: "input" }),
      });
      if (path === "/api/projects/rules") return Promise.resolve({
        ok: true, json: async () => ({ rules: [], errors: [] }),
      });
      return Promise.resolve({ ok: false, json: async () => ({}) });
    };
    run(...globals.map(() => stub()), fetcher);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter(path => path === "/api/projects/rules")).toHaveLength(topicsEnabled ? 1 : 0);
  }
});

test("Ideas refresh clears stale or failed status without erasing action feedback on its own refresh", async () => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  const start = script.indexOf("  async function refreshIdeas(");
  const end = script.indexOf("  async function runIdeaAction(", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  type IdeasState = { failed: boolean; items: unknown[]; open: number; showAll: boolean; version: number };
  const makeRefresh = new Function("state", "ideasState", "ideaNotice", "paintIdeasBadge", "renderIdeas", "fetch", "ideaErrorText",
    `${script.slice(start, end)} return refreshIdeas;`) as (
      state: { repliesEnabled: boolean }, ideasState: IdeasState, ideaNotice: (text: string, error?: boolean) => void,
      paintIdeasBadge: () => void, renderIdeas: () => void,
      fetch: (url: string, options: unknown) => Promise<{ ok: boolean; json: () => Promise<{ ideas?: unknown[]; open?: number }> }>,
      ideaErrorText: (response: unknown, payload: unknown) => string,
    ) => (clearStatus?: boolean) => Promise<void>;
  const ideasState: IdeasState = { failed: false, items: [], open: 0, showAll: false, version: 0 };
  let status = "Sent to alpha.";
  let fail = false;
  const refresh = makeRefresh({ repliesEnabled: true }, ideasState, text => { status = text; },
    () => {}, () => {}, async () => {
      if (fail) throw new Error("synthetic network failure");
      return { ok: true, json: async () => ({ ideas: [], open: 0 }) };
    }, () => "synthetic response failure");

  await refresh();
  expect(status).toBe("Sent to alpha.");
  await refresh(true);
  expect(status).toBe("");
  fail = true;
  await refresh();
  expect(status).toBe("Ideas could not be loaded: synthetic network failure");
  fail = false;
  await refresh();
  expect(status).toBe("");
});

test("Ideas SSE refresh preserves transient action feedback", () => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  const start = script.indexOf("    source.addEventListener('ideas'");
  const end = script.indexOf("\n", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const listeners = new Map<string, (event: { data: string }) => void>();
  const ideasState = { open: 0 };
  let status = "Sent to alpha.";
  const refreshCalls: (boolean | undefined)[] = [];
  const register = new Function("source", "ideasState", "paintIdeasBadge", "refreshIdeas", script.slice(start, end));
  register({ addEventListener: (name: string, handler: (event: { data: string }) => void) => listeners.set(name, handler) },
    ideasState, () => {}, (clearStatus?: boolean) => {
      refreshCalls.push(clearStatus);
      if (clearStatus) status = "";
    });

  listeners.get("ideas")!({ data: JSON.stringify({ open: 2 }) });
  expect(ideasState.open).toBe(2);
  expect(refreshCalls).toEqual([undefined]);
  expect(status).toBe("Sent to alpha.");
});


test("console history requests the compound cursor at the oldest retained response", async () => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  const start = script.indexOf("  async function loadConsoleHistory()");
  const end = script.indexOf("  function sortSessions(", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const key = "synthetic-host|claude|synthetic-history";
  const consoleState = {
    selectedKey: key,
    reading: new Map([[key, { lastResponses: [
      { ts: 100, id: 7 }, { ts: 100, id: 3 }, { ts: 100, id: 5 },
    ] }]]),
    history: new Map(),
  };
  const urls: string[] = [];
  const load = new Function("consoleState", "responsesOf", "byId", "renderConsoleHistory", "fetch",
    `${script.slice(start, end)} return loadConsoleHistory;`)(
      consoleState, session => session.lastResponses, (value, key) => value[key], () => {},
      async url => {
        urls.push(url);
        return { ok: true, json: async () => ({ responses: [], hasMore: false }) };
      }) as () => Promise<void>;

  await load();
  expect(urls).toEqual([
    `/api/sessions/${encodeURIComponent(key)}/responses?limit=50&before=100&beforeId=3`,
  ]);
});
test("readConsoleLocation and setViewUrl preserve timeline view hash without session pollution", () => {
  const script = readFileSync(join(import.meta.dir, "../public/app.js"), "utf8");
  const start = script.indexOf("  function readConsoleLocation()");
  const end = script.indexOf("  function setConsolePaneMode(");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const urlStart = script.indexOf("  function setSessionUrl(");
  const slice = script.slice(start, script.indexOf("  const initialConsoleLocation")) + "\n" + script.slice(urlStart, end);
  const harness = new Function("location", "history", "state", "consoleState", `
    ${slice}
    return { readConsoleLocation, setSessionUrl, setViewUrl };
  `);
  const loc = { href: "http://127.0.0.1:4777/#session=mac%7Cclaude%7Cs1&response=3", hash: "#session=mac%7Cclaude%7Cs1&response=3" };
  const calls: [string, string][] = [];
  const hist = {
    pushState: (_s: unknown, _t: string, url: URL) => { loc.href = url.toString(); loc.hash = url.hash; calls.push(["push", url.hash]); },
    replaceState: (_s: unknown, _t: string, url: URL) => { loc.href = url.toString(); loc.hash = url.hash; calls.push(["replace", url.hash]); },
  };
  const state = { view: "timeline" };
  const consoleState = { selectedKey: "mac|claude|s1" };
  const api = harness(loc, hist, state, consoleState);

  api.setViewUrl("timeline", true);
  expect(loc.hash).toBe("#view=timeline");
  expect(api.readConsoleLocation()).toEqual({ key: "", response: null, view: "timeline" });

  // Automatic background session selection while in timeline view does not overwrite #view=timeline.
  api.setSessionUrl("mac|claude|s1", false, 3);
  expect(loc.hash).toBe("#view=timeline");

  // Returning to console restores the selected session hash.
  state.view = "console";
  api.setViewUrl("console", true);
  expect(loc.hash).toBe("#session=mac%7Cclaude%7Cs1");
  expect(api.readConsoleLocation()).toEqual({ key: "mac|claude|s1", response: null, view: "console" });
});

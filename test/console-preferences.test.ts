import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashServer } from "../src/server.ts";
import type { ConsolePreferences, ConsoleViewConfig } from "../src/console-preferences.ts";
import type { DashDB } from "../src/db.ts";

interface TestApp {
  server: { port: number };
  db: DashDB;
  close(): void;
}

let app: TestApp;
let base: string;
let directory: string;
let dataPath: string;
let originalEnv: Record<string, string | undefined>;
const envNames = ["DASH_TAILNET_PORT", "DASH_ALLOWED_HOSTS", "DASH_ALLOWED_PEERS", "DASH_TG_TOPICS", "DASH_TELEGRAM", "DASH_REPLIES", "DASH_JUDGE"];

function startApp() {
  app = createDashServer({ port: 0, hostname: "127.0.0.1", dataPath, backfill: false, liveness: false });
  base = `http://127.0.0.1:${app.server.port}`;
}

beforeEach(() => {
  originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) process.env[name] = "";
  directory = mkdtempSync(join(tmpdir(), "dash-console-preferences-"));
  dataPath = join(directory, "dash.sqlite");
  startApp();
});

afterEach(() => {
  app.close();
  rmSync(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function config(overrides: Partial<ConsoleViewConfig> = {}): ConsoleViewConfig {
  return {
    search: "", host: "", project: null, account: null, harness: "", status: "", headless: false, ended: false,
    group: "", density: "comfortable", columns: ["project", "host", "account", "harness", "age"],
    ...overrides,
  };
}

function post(body: unknown) {
  return fetch(`${base}/api/console/preferences`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function getPreferences(): Promise<ConsolePreferences> {
  const response = await fetch(`${base}/api/console/preferences`);
  expect(response.status).toBe(200);
  return await response.json() as ConsolePreferences;
}

function addRetainedSession(sessionId: string) {
  app.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId, kind: "session_start", ts: Date.now(), interactive: true });
  return `synthetic-host|claude|${sessionId}`;
}

test("GET works with replies disabled and saved views preserve literal labels through CRUD", async () => {
  expect(await getPreferences()).toEqual({ revision: 0, pins: [], views: [] });

  const initialConfig = config({ host: "removed-host", project: "removed-project", account: "removed-account", search: "review", status: "unknown" });
  const createdResponse = await post({ action: "create", name: "  Current view  ", config: initialConfig });
  expect(createdResponse.status).toBe(200);
  const created = await createdResponse.json() as ConsolePreferences;
  expect(created).toMatchObject({ revision: 1, pins: [], views: [{ name: "Current view", config: initialConfig }] });

  const duplicate = await post({ action: "create", name: "Current view", config: config() });
  expect(duplicate.status).toBe(409);
  const id = created.views[0]!.id;
  const renamed = await post({ action: "update", id, name: "Renamed" });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toEqual({ revision: 2, pins: [], views: [{ id, name: "Renamed", config: initialConfig }] });

  const nextConfig = config({ project: "", account: "", status: "ended", ended: true });
  const updated = await post({ action: "update", id, config: nextConfig });
  expect(await updated.json()).toEqual({ revision: 3, pins: [], views: [{ id, name: "Renamed", config: nextConfig }] });
  const noChange = await post({ action: "update", id, config: nextConfig });
  expect(await noChange.json()).toEqual({ revision: 3, pins: [], views: [{ id, name: "Renamed", config: nextConfig }] });

  const deleted = await post({ action: "delete", id });
  expect(await deleted.json()).toEqual({ revision: 4, pins: [], views: [] });
  expect((await post({ action: "delete", id })).status).toBe(404);
  expect((await post({ action: "update", id, name: "Missing" })).status).toBe(404);
});
test("renaming to another view's exact trimmed name is rejected without changing state", async () => {
  const first = await (await post({ action: "create", name: "One", config: config() })).json() as ConsolePreferences;
  const second = await (await post({ action: "create", name: "Two", config: config({ search: "second" }) })).json() as ConsolePreferences;
  const stateBeforeRename = await getPreferences();
  const response = await post({ action: "update", id: second.views[1]!.id, name: "  One  " });
  expect(response.status).toBe(409);
  expect(await getPreferences()).toEqual(stateBeforeRename);
  expect(first.views[0]!.name).toBe("One");
});


test("pin actions preserve immutable keys, reject unavailable pin targets, and allow unpin after removal", async () => {
  const key = addRetainedSession("pin-target");
  const missing = "removed-host|omp|deleted-session";
  expect((await post({ action: "pin", key: missing, pinned: true })).status).toBe(404);

  const pinned = await post({ action: "pin", key, pinned: true });
  expect(await pinned.json()).toEqual({ revision: 1, pins: [key], views: [] });
  expect(await (await post({ action: "pin", key, pinned: true })).json()).toEqual({ revision: 1, pins: [key], views: [] });

  app.db.sqlite.query("DELETE FROM sessions WHERE key=?").run(key);
  const unpinned = await post({ action: "pin", key, pinned: false });
  expect(await unpinned.json()).toEqual({ revision: 2, pins: [], views: [] });
  expect(await (await post({ action: "pin", key: missing, pinned: false })).json()).toEqual({ revision: 2, pins: [], views: [] });
});

test("strict validation rejects malformed configs, extra target/draft fields, and untrusted writes", async () => {
  const valid = config();
  const invalidConfigs: unknown[] = [
    Object.fromEntries(Object.entries(valid).filter(([field]) => field !== "search")),
    { ...valid, selectedKey: "secret-target" },
    { ...valid, draftText: "private draft" },
    { ...valid, density: "wide" },
    { ...valid, columns: ["host", "host"] },
    { ...valid, status: "ended" },
    { ...valid, search: "s".repeat(1025) },
    { ...valid, host: "h".repeat(1025) },
    { ...valid, project: "p".repeat(1025) },
    { ...valid, account: "a".repeat(1025) },
    { ...valid, missing: true },
  ];
  for (const invalid of invalidConfigs) {
    const response = await post({ action: "create", name: "Bad config", config: invalid });
    expect(response.status).toBe(400);
    expect(typeof (await response.json() as { error: unknown }).error).toBe("string");
  }
  expect((await post({ action: "create", name: "x".repeat(81), config: valid })).status).toBe(400);
  expect((await post({ action: "create", name: "   ", config: valid })).status).toBe(400);
  expect((await post({ action: "create", name: "line\nbreak", config: valid })).status).toBe(400);
  expect((await post({ action: "pin", key: "k".repeat(2049), pinned: false })).status).toBe(400);
  expect((await post({ action: "pin", key: "k", pinned: true, target: "other" })).status).toBe(400);
  expect((await post({ action: "update", id: "missing" })).status).toBe(400);

  const foreign = await fetch(`${base}/api/console/preferences`, {
    method: "POST", headers: { Origin: "http://foreign.example", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", name: "Blocked", config: valid }),
  });
  expect(foreign.status).toBe(403);
  const wrongContentType = await fetch(`${base}/api/console/preferences`, {
    method: "POST", headers: { Origin: base, "Content-Type": "text/plain" }, body: "{}",
  });
  expect(wrongContentType.status).toBe(415);
  expect(await getPreferences()).toEqual({ revision: 0, pins: [], views: [] });
});
test("accepted string boundaries and collection caps are enforced without truncation", async () => {
  const maximumConfig = config({
    search: "s".repeat(1024), host: "h".repeat(1024), project: "p".repeat(1024), account: "a".repeat(1024),
  });
  const maximumName = "n".repeat(80);
  const accepted = await post({ action: "create", name: maximumName, config: maximumConfig });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ revision: 1, views: [{ name: maximumName, config: maximumConfig }] });
  const maximumKey = "k".repeat(2048);
  expect(await (await post({ action: "pin", key: maximumKey, pinned: false })).json()).toMatchObject({ revision: 1, pins: [] });

  const fullViews = Array.from({ length: 100 }, (_, index) => ({
    id: `seed-view-${index}`, name: `Seed view ${index}`, config: config(),
  }));
  app.db.setSetting("console.preferences", JSON.stringify({ revision: 10, pins: [], views: fullViews }));
  expect((await post({ action: "create", name: "One too many", config: config() })).status).toBe(400);
  const viewsAfterRejectedWrite = await getPreferences();
  expect(viewsAfterRejectedWrite.revision).toBe(10);
  expect(viewsAfterRejectedWrite.views).toHaveLength(100);

  const existingKey = addRetainedSession("at-pin-capacity");
  const fullPins = Array.from({ length: 1000 }, (_, index) => `deleted-host|claude|removed-${index}`);
  app.db.setSetting("console.preferences", JSON.stringify({ revision: 11, pins: fullPins, views: [] }));
  expect((await post({ action: "pin", key: existingKey, pinned: true })).status).toBe(400);
  const pinsAfterRejectedWrite = await getPreferences();
  expect(pinsAfterRejectedWrite.revision).toBe(11);
  expect(pinsAfterRejectedWrite.pins).toHaveLength(1000);
  expect(pinsAfterRejectedWrite.pins[999]).toBe(fullPins[999]);
  const unpinnedMissing = await (await post({ action: "pin", key: fullPins[0], pinned: false })).json() as ConsolePreferences;
  expect(unpinnedMissing.revision).toBe(12);
  expect(unpinnedMissing.pins).toEqual(fullPins.slice(1));
});


test("independent concurrent actions preserve pins and edits to different views", async () => {
  const firstKey = addRetainedSession("first-client");
  const secondKey = addRetainedSession("second-client");
  const first = await (await post({ action: "create", name: "First", config: config({ search: "one" }) })).json() as ConsolePreferences;
  const second = await (await post({ action: "create", name: "Second", config: config({ search: "two" }) })).json() as ConsolePreferences;
  const firstId = first.views[0]!.id, secondId = second.views[1]!.id;

  const results = await Promise.all([
    post({ action: "pin", key: firstKey, pinned: true }),
    post({ action: "pin", key: secondKey, pinned: true }),
    post({ action: "update", id: firstId, name: "First renamed" }),
    post({ action: "update", id: secondId, config: config({ search: "two updated" }) }),
  ]);
  expect(results.map(response => response.status)).toEqual([200, 200, 200, 200]);
  const finalState = await getPreferences();
  expect(finalState.revision).toBe(6);
  expect([...finalState.pins].sort()).toEqual([firstKey, secondKey].sort());
  expect(finalState.views).toEqual([
    { id: firstId, name: "First renamed", config: config({ search: "one" }) },
    { id: secondId, name: "Second", config: config({ search: "two updated" }) },
  ]);
});

test("saved views and pinned identities survive database restart", async () => {
  const key = addRetainedSession("restart-pin");
  const configValue = config({ host: "offline-host", project: "removed-label", account: "" });
  expect((await post({ action: "create", name: "Persisted", config: configValue })).status).toBe(200);
  expect((await post({ action: "pin", key, pinned: true })).status).toBe(200);
  expect(await getPreferences()).toMatchObject({ pins: [key], views: [{ name: "Persisted", config: configValue }] });

  const beforeRestart = await getPreferences();
  app.close();
  startApp();
  expect(await getPreferences()).toEqual(beforeRestart);
});

test("corrupt stored settings fail closed without erasing the persisted value", async () => {
  app.db.setSetting("console.preferences", "not-json");
  const response = await fetch(`${base}/api/console/preferences`);
  expect(response.status).toBe(500);
  expect(app.db.getSetting("console.preferences")).toBe("not-json");
});

test("failed writes report storage errors and leave the prior preferences intact", async () => {
  await post({ action: "create", name: "Before failure", config: config() });
  const storedBeforeFailure = app.db.getSetting("console.preferences");
  app.db.sqlite.exec("PRAGMA query_only = ON");

  const response = await post({ action: "create", name: "Must not be lost", config: config({ search: "new" }) });
  expect(response.status).toBe(500);
  expect(app.db.getSetting("console.preferences")).toBe(storedBeforeFailure);
});

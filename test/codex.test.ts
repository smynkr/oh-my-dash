import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAdapter, codexIdentitiesFromEnv, type CodexAdapter, type CodexAdapterOptions, type CodexIdentityConfig } from "../src/codex.ts";
import { DashDB } from "../src/db.ts";
import type { LivenessRecord } from "../src/liveness.ts";
import type { NormalizedEvent } from "../src/normalize.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/codex-app-server.ts", import.meta.url));
type FakeProfile = {
  threadId: string;
  title?: string;
  cwd?: string;
  turns?: unknown[];
  turnsFile?: string;
  turnsDelayMs?: number;
  turnAfterStart?: unknown;
  threadMetadataFile?: string;
  threadListMetadataFile?: string;
  threadReadMetadataFile?: string;
  version?: string;
};
type ControlAction = "turn/start" | "turn/steer" | "turn/interrupt";
type ControlDelivery = {
  id: number;
  target: string;
  action: ControlAction;
  text?: string;
  expectedTurnId?: string;
};
type RpcRecord = Record<string, unknown> & { method?: string; params?: Record<string, unknown> };

type FakeServerConfig = {
  profiles: Record<string, FakeProfile>;
  unsupportedMethods?: string[];
  unsupportedOnceMethods?: string[];
  loadedThreads?: string[];
  failRequests?: string[];
  failOnceMethods?: string[];
  failRequestMessages?: Record<string, string>;
  timeoutMethods?: string[];
  exitMethods?: string[];
  failAfterInitialSync?: string[];
  crashFirstLaunch?: boolean;
  crashDelayMs?: number;
};

class ChangeSignal {
  private pending = Promise.withResolvers<void>();

  notify(): void {
    const previous = this.pending;
    this.pending = Promise.withResolvers<void>();
    previous.resolve();
  }

  wait(): Promise<void> { return this.pending.promise; }
}

let changes: ChangeSignal;

class FakeControlHub {
  readonly waitSessions = new Set<string>();
  readonly commits: Record<string, unknown>[] = [];
  readonly receipts: Record<string, unknown>[] = [];
  readonly receiptAttempts: Record<string, unknown>[] = [];
  readonly livenessReports: Record<string, unknown>[] = [];
  readonly livenessAttempts: Record<string, unknown>[] = [];
  readonly codexIngests: { event: Record<string, unknown>; eventId: string | null }[] = [];
  ackFailuresRemaining = 0;
  livenessFailuresRemaining = 0;
  ackStatus?: number;
  private readonly deliveries = new Map<string, ControlDelivery[]>();
  private readonly deliveryWaiters = new Map<string, Set<() => void>>();
  private readonly server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request => this.handle(request),
  });

  get base(): string { return `http://127.0.0.1:${this.server.port}`; }

  enqueue(session: string, delivery: ControlDelivery): void {
    const queued = this.deliveries.get(session) ?? [];
    queued.push(delivery);
    this.deliveries.set(session, queued);
    changes.notify();
    for (const release of this.deliveryWaiters.get(session) ?? []) release();
  }

  close(): void { this.server.stop(true); }

  private take(session: string): ControlDelivery | undefined {
    const queued = this.deliveries.get(session);
    const delivery = queued?.shift();
    if (queued && !queued.length) this.deliveries.delete(session);
    return delivery;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/reply/wait/codex") {
      const session = url.searchParams.get("session") ?? "";
      this.waitSessions.add(session);
      changes.notify();
      const ready = this.take(session);
      if (ready) return Response.json(ready);
      await this.waitForControl(request, session);
      changes.notify();
      const delivery = this.take(session);
      return delivery ? Response.json(delivery) : new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/reply/commit") {
      this.commits.push(await request.json() as Record<string, unknown>);
      changes.notify();
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/reply/ack") {
      const receipt = await request.json() as Record<string, unknown>;
      this.receiptAttempts.push(receipt);
      changes.notify();
      if (this.ackFailuresRemaining > 0) {
        this.ackFailuresRemaining--;
        return new Response(null, { status: 503 });
      }
      if (this.ackStatus !== undefined) return new Response(null, { status: this.ackStatus });
      this.receipts.push(receipt);
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/ingest/codex") {
      const event = await request.json() as Record<string, unknown>;
      this.codexIngests.push({ event, eventId: request.headers.get("X-Dash-Event-Id") });
      changes.notify();
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/ingest/liveness/codex") {
      const liveness = await request.json() as Record<string, unknown>;
      this.livenessAttempts.push(liveness);
      changes.notify();
      if (this.livenessFailuresRemaining > 0) {
        this.livenessFailuresRemaining--;
        return new Response(null, { status: 503 });
      }
      this.livenessReports.push(liveness);
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 204 });
  }

  private async waitForControl(request: Request, session: string): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const waiters = this.deliveryWaiters.get(session) ?? new Set<() => void>();
    const finish = () => {
      if (!waiters.delete(finish)) return;
      if (!waiters.size) this.deliveryWaiters.delete(session);
      request.signal.removeEventListener("abort", finish);
      resolve();
    };
    waiters.add(finish);
    this.deliveryWaiters.set(session, waiters);
    request.signal.addEventListener("abort", finish, { once: true });
    if (request.signal.aborted) finish();
    await promise;
  }
}

let temporaryRoot: string;
let activeAdapter: CodexAdapter | undefined;
let activeHub: FakeControlHub | undefined;
let spawnedChildren: ChildProcess[];

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "dash-codex-adapter-"));
  activeAdapter = undefined;
  activeHub = undefined;
  spawnedChildren = [];
  changes = new ChangeSignal();
});

afterEach(async () => {
  activeAdapter?.close();
  activeHub?.close();
  await Promise.all(spawnedChildren.map(waitForChildExit));
  rmSync(temporaryRoot, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await changes.wait();
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit").catch(() => undefined);
}

function makeHome(name: string): string {
  const home = join(temporaryRoot, name);
  mkdirSync(home, { recursive: true });
  return home;
}

function sessionIdFor(alias: string, threadId: string): string {
  const tag = createHash("sha256").update(alias.trim().toLowerCase()).digest("hex").slice(0, 12);
  return `c_${tag}_${threadId}`;
}

function sessionKey(host: string, sessionId: string): string {
  return `${host}|codex|${sessionId}`;
}

function readRpc(home: string): RpcRecord[] {
  const path = join(home, "fake-app-server-rpc.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as RpcRecord);
}

function launchCount(home: string): number {
  const path = join(home, "fake-app-server-launches");
  return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}

function activeTurn(id: string, prompt: string): Record<string, unknown> {
  return {
    id,
    status: "inProgress",
    startedAt: 1_800_000_001,
    items: [{ type: "userMessage", content: [{ type: "text", text: prompt }] }],
  };
}

function completedTurn(id: string, prompt: string, output: string): Record<string, unknown> {
  return {
    id,
    status: "completed",
    startedAt: 1_800_000_002,
    completedAt: 1_800_000_003,
    items: [
      { type: "userMessage", content: [{ type: "text", text: prompt }] },
      { type: "agentMessage", phase: "commentary", text: "internal commentary is not the final answer" },
      { type: "agentMessage", phase: "final_answer", text: output },
    ],
  };
}

function startAdapter(options: {
  identities: CodexIdentityConfig[];
  fixture: FakeServerConfig;
  hub?: FakeControlHub;
  restartDelayMs?: number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  spawnImpl?: NonNullable<CodexAdapterOptions["spawnImpl"]>;
}): { adapter: CodexAdapter; events: NormalizedEvent[]; liveness: LivenessRecord[][] } {
  const events: NormalizedEvent[] = [];
  const liveness: LivenessRecord[][] = [];
  const spawnImpl = ((command: string, args: readonly string[], spawnOptions?: SpawnOptions) => {
    const childOptions: SpawnOptions = {
      ...spawnOptions,
      env: { ...spawnOptions?.env, HOME: temporaryRoot, TMPDIR: temporaryRoot },
    };
    const child = options.spawnImpl
      ? options.spawnImpl(command, args, childOptions)
      : spawn(command, args, childOptions);
    spawnedChildren.push(child);
    child.stdout?.on("data", () => changes.notify());
    child.once("exit", () => changes.notify());
    return child;
  }) as NonNullable<CodexAdapterOptions["spawnImpl"]>;
  const adapter = createCodexAdapter({
    host: "codex-test-host",
    identities: options.identities,
    command: process.execPath,
    args: [fixturePath, JSON.stringify(options.fixture)],
    spawnImpl,
    ...(options.hub ? { hubUrl: options.hub.base, forwardEvents: true, repliesEnabled: true } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
    pollIntervalMs: options.pollIntervalMs ?? 15_000,
    retryDelayMs: options.retryDelayMs ?? 50,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    restartDelayMs: options.restartDelayMs ?? 50,
    onEvent: event => { events.push(event); changes.notify(); },
    onLiveness: records => { liveness.push(records); changes.notify(); },
  });
  activeAdapter = adapter;
  adapter.start();
  return { adapter, events, liveness };
}
test("Codex identity configuration requires explicit homes and canonicalizes aliases", () => {
  const home = makeHome("canonical-home");
  const link = join(temporaryRoot, "canonical-home-link");
  symlinkSync(home, link, "dir");
  const identities = (homes: string[]) => JSON.stringify(homes.map((codeHome, index) => ({
    accountAlias: `Identity${index + 1}`, codeHome,
  })));
  expect(() => codexIdentitiesFromEnv({
    HOME: temporaryRoot, CODEX_HOME: home, DASH_CODEX_IDENTITIES: identities([home, link]),
  })).toThrow("unique account aliases and CODEX_HOME paths");
  expect(() => codexIdentitiesFromEnv({
    CODEX_HOME: home, DASH_CODEX_IDENTITIES: JSON.stringify([{ accountAlias: "MissingHome" }]),
  })).toThrow("requires its own codeHome");
  expect(codexIdentitiesFromEnv({ CODEX_HOME: home, DASH_ACCOUNT_ALIAS: "Default" })).toEqual([
    { accountAlias: "Default", codeHome: realpathSync(home) },
  ]);
});


describe("Codex app-server adapter", () => {
  test("discovers and identity-maps app-server threads while ingesting prompts, output, and liveness", async () => {
    const alphaHome = makeHome("alpha-home");
    const betaHome = makeHome("beta-home");
    const threadId = "shared_thread";
    const alphaTurnId = "alpha_active_turn";
    const betaTurnId = "beta_active_turn";
    const { adapter, events, liveness } = startAdapter({
      identities: [
        { accountAlias: "Alpha", codeHome: alphaHome },
        { accountAlias: "Beta", codeHome: betaHome },
      ],
      fixture: { profiles: {
        [basename(alphaHome)]: {
          threadId, title: "Alpha history", cwd: "/fake/alpha", turns: [
            activeTurn(alphaTurnId, "alpha current prompt"),
            completedTurn("alpha_completed_turn", "alpha earlier prompt", "alpha final output"),
          ],
        },
        [basename(betaHome)]: {
          threadId, title: "Beta history", cwd: "/fake/beta", turns: [
            activeTurn(betaTurnId, "beta current prompt"),
            completedTurn("beta_completed_turn", "beta earlier prompt", "beta final output"),
          ],
        },
      } },
    });
    await adapter.waitForReady(5_000);

    const alphaSession = sessionIdFor("Alpha", threadId);
    const betaSession = sessionIdFor("Beta", threadId);
    await waitUntil(() =>
      events.some(event => event.kind === "session_start" && event.accountAlias === "Alpha") &&
      events.some(event => event.kind === "session_start" && event.accountAlias === "Beta") &&
      events.some(event => event.kind === "prompt" && event.accountAlias === "Alpha") &&
      events.some(event => event.kind === "prompt" && event.accountAlias === "Beta") &&
      events.some(event => event.kind === "response" && event.accountAlias === "Alpha") &&
      events.some(event => event.kind === "response" && event.accountAlias === "Beta") &&
      liveness.some(records => records.some(record => record.sessionId === alphaSession) &&
        records.some(record => record.sessionId === betaSession)));

    const alphaStart = events.find(event => event.kind === "session_start" && event.accountAlias === "Alpha");
    const betaStart = events.find(event => event.kind === "session_start" && event.accountAlias === "Beta");
    expect(alphaStart).toMatchObject({
      host: "codex-test-host", harness: "codex", sessionId: alphaSession, title: "Alpha history", cwd: "/fake/alpha",
      accountAlias: "Alpha", codexControl: { source: "vscode", appServerOwned: true, turnStart: true, turnInterrupt: true },
    });
    expect(betaStart).toMatchObject({
      host: "codex-test-host", harness: "codex", sessionId: betaSession, title: "Beta history", cwd: "/fake/beta",
      accountAlias: "Beta", codexControl: { source: "vscode", appServerOwned: true, turnStart: true, turnInterrupt: true },
    });
    expect(alphaSession).not.toBe(betaSession);
    const alphaPrompt = events.find(event => event.kind === "prompt" && event.accountAlias === "Alpha");
    const betaPrompt = events.find(event => event.kind === "prompt" && event.accountAlias === "Beta");
    expect(alphaPrompt?.text).toBe("alpha current prompt");
    expect(alphaPrompt?.codexControl).toMatchObject({ activeTurnId: alphaTurnId, turnSteer: true });
    expect(betaPrompt?.text).toBe("beta current prompt");
    expect(betaPrompt?.codexControl).toMatchObject({ activeTurnId: betaTurnId, turnSteer: true });
    expect(events.find(event => event.kind === "response" && event.accountAlias === "Alpha")).toMatchObject({
      sessionId: alphaSession, prompt: "alpha earlier prompt", text: "alpha final output", responseSource: "backfill",
      codexControl: { activeTurnId: alphaTurnId },
    });
    expect(events.find(event => event.kind === "response" && event.accountAlias === "Beta")).toMatchObject({
      sessionId: betaSession, prompt: "beta earlier prompt", text: "beta final output", responseSource: "backfill",
      codexControl: { activeTurnId: betaTurnId },
    });
    const latestLiveness = liveness.at(-1) ?? [];
    expect(latestLiveness).toContainEqual(expect.objectContaining({
      host: "codex-test-host", harness: "codex", sessionId: alphaSession, cwd: "/fake/alpha", name: "Alpha history", detail: "busy",
    }));
    expect(latestLiveness).toContainEqual(expect.objectContaining({
      host: "codex-test-host", harness: "codex", sessionId: betaSession, cwd: "/fake/beta", name: "Beta history", detail: "busy",
    }));
  }, 10_000);
  test("remote Codex turn events carry a stable idempotency key", async () => {
    const home = makeHome("event-id-home"), hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "event_id_thread", turnId = "event_id_turn";
    const session = sessionIdFor("EventId",threadId);
    const { adapter } = startAdapter({
      identities:[{accountAlias:"EventId",codeHome:home}],
      fixture:{profiles:{[basename(home)]:{threadId,title:"Event identity",
        turns:[completedTurn(turnId,"stable prompt","stable output")]}}},
      hub,
    });
    await adapter.waitForReady(5_000);
    await waitUntil(() => hub.codexIngests.some(item => item.event.sessionId === session && item.event.kind === "response"));
    const forwarded = hub.codexIngests.find(item => item.event.sessionId === session && item.event.kind === "response")!;
    expect(forwarded.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(forwarded.eventId).toBe(createHash("sha256").update(threadId).update("\0").update(turnId).update("\0")
      .update(JSON.stringify(forwarded.event)).digest("hex"));
  }, 10_000);
  test("session snapshot events get unique IDs after app-server restart", async () => {
    const home = makeHome("session-start-restart-event-id-home"), hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "session_start_restart_id_thread", session = sessionIdFor("RestartEventId",threadId);
    const { adapter } = startAdapter({
      identities:[{accountAlias:"RestartEventId",codeHome:home}],
      fixture: { crashFirstLaunch:true,crashDelayMs:750,
        profiles:{[basename(home)]:{threadId,title:"Restart snapshot"}} },
      hub,
    });
    await adapter.waitForReady(5_000);
    await waitUntil(() => hub.codexIngests.some(item => item.event.sessionId === session && item.event.kind === "session_start"));
    const initial = hub.codexIngests.find(item => item.event.sessionId === session && item.event.kind === "session_start")!;
    await waitUntil(() => launchCount(home) >= 2 &&
      hub.codexIngests.filter(item => item.event.sessionId === session && item.event.kind === "session_start").length >= 2);
    const snapshots = hub.codexIngests.filter(item => item.event.sessionId === session && item.event.kind === "session_start");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.event).toEqual(snapshots[1]?.event);
    expect(initial.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshots[1]?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshots[1]?.eventId).not.toBe(initial.eventId);
  }, 10_000);

  test("remote event IDs distinguish identical output from different turns", async () => {
    const home = makeHome("distinct-turn-event-home"), hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "distinct_turn_event_thread", session = sessionIdFor("DistinctTurns", threadId);
    const { adapter } = startAdapter({
      identities: [{ accountAlias:"DistinctTurns",codeHome:home }],
      fixture: { profiles: { [basename(home)]: {
        threadId, title:"Identical turn output", turns: [
          completedTurn("first_identical_turn", "same prompt", "same output"),
          completedTurn("second_identical_turn", "same prompt", "same output"),
        ],
      } } },
      hub,
    });
    await adapter.waitForReady(5_000);
    await waitUntil(() => hub.codexIngests.filter(item => item.event.sessionId === session && item.event.kind === "response").length === 2);
    const responses = hub.codexIngests.filter(item => item.event.sessionId === session && item.event.kind === "response");
    expect(responses.map(item => item.event)).toHaveLength(2);
    expect(responses[0]?.event).toMatchObject({ ts:1_800_000_003_000,text:"same output",prompt:"same prompt" });
    expect(responses[1]?.event).toMatchObject({ ts:1_800_000_003_000,text:"same output",prompt:"same prompt" });
    expect(new Set(responses.map(item => item.eventId)).size).toBe(2);
  }, 10_000);
  test("changed history emits only new terminal turns and keeps the observed active turn", async () => {
    const home = makeHome("history-refresh-home");
    const threadId = "history_refresh_thread";
    const turnsFile = join(home, "turns.json");
    const firstTurns = [
      activeTurn("history_active_turn", "still running"),
      completedTurn("history_done_turn", "earlier prompt", "earlier output"),
      { id:"history_failed_turn",status:"failed",completedAt:1_800_000_004,
        items:[{type:"userMessage",content:[{type:"text",text:"failed prompt"}]}],error:{message:"synthetic failure"} },
    ];
    writeFileSync(turnsFile, JSON.stringify(firstTurns));
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"History",codeHome:home }],
      fixture: { profiles: { [basename(home)]: { threadId, title:"Refresh history", turnsFile } } },
      pollIntervalMs: 250,
    });
    await adapter.waitForReady(5_000);
    await waitUntil(() => events.some(event => event.kind === "response" && event.text === "earlier output") &&
      events.some(event => event.kind === "error" && event.detail === "failed"));
    const completedActive = completedTurn("history_active_turn", "still running", "fresh active output");
    writeFileSync(turnsFile, JSON.stringify([completedActive, ...firstTurns.slice(1), completedTurn("history_new_turn", "new prompt", "new output")]));
    await waitUntil(() => events.some(event => event.kind === "response" && event.text === "new output") &&
      events.some(event => event.kind === "response" && event.text === "fresh active output"));
    expect(events.filter(event => event.kind === "response" && event.text === "earlier output")).toHaveLength(1);
    expect(events.filter(event => event.kind === "error" && event.detail === "failed")).toHaveLength(1);
    expect(events.filter(event => event.kind === "prompt" && event.text === "still running")).toHaveLength(1);
    expect(events.find(event => event.kind === "response" && event.text === "earlier output")?.codexControl?.activeTurnId).toBe("history_active_turn");
    const freshResponse = events.find(event => event.kind === "response" && event.text === "fresh active output");
    expect(freshResponse).toBeDefined();
    expect(freshResponse?.responseSource).toBeUndefined();
    expect(events.find(event => event.kind === "response" && event.text === "new output")?.responseSource).toBe("backfill");
    const db = new DashDB(":memory:");
    try {
      db.applyEvent(freshResponse!);
      expect(db.getSession(sessionKey("codex-test-host", sessionIdFor("History", threadId)))?.unreadCount).toBe(1);
    } finally { db.close(); }
  }, 10_000);
  test("retries a failed turns read after metadata was recorded", async () => {
    const home = makeHome("turn-read-retry-home");
    const threadId = "turn_read_retry_thread";
    const turnsFile = join(home, "turns.json");
    const threadMetadataFile = join(home, "thread.json");
    const firstTurns = [completedTurn("existing_turn", "existing prompt", "existing output")];
    writeFileSync(turnsFile, JSON.stringify(firstTurns));
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"ReadRetry",codeHome:home }],
      fixture: {
        profiles: { [basename(home)]: { threadId, title:"Retry turn reads", turnsFile, threadMetadataFile } },
        failAfterInitialSync: ["thread/turns/list"],
      },
      pollIntervalMs: 250,
    });
    await adapter.waitForReady(5_000);
    await waitUntil(() => events.some(event => event.kind === "response" && event.text === "existing output"));
    writeFileSync(turnsFile, JSON.stringify([...firstTurns, completedTurn("new_turn", "new prompt", "new output")]));
    writeFileSync(threadMetadataFile, JSON.stringify({ updatedAt: 1_800_000_001 }));
    await waitUntil(() => events.some(event => event.kind === "response" && event.text === "new output"));
    expect(events.filter(event => event.kind === "response" && event.text === "existing output")).toHaveLength(1);
    expect(readRpc(home).filter(request => request.method === "thread/turns/list").length).toBeGreaterThanOrEqual(3);
  }, 10_000);
  test("a completed empty-output turn refreshes the active-turn session snapshot", async () => {
    const home = makeHome("empty-completion-home");
    const threadId = "empty_completion_thread";
    const turnsFile = join(home, "turns.json");
    const threadMetadataFile = join(home, "thread.json");
    const turnId = "empty_completion_active_turn";
    writeFileSync(turnsFile, JSON.stringify([activeTurn(turnId, "still running")]));
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"EmptyCompletion",codeHome:home }],
      fixture: { profiles: { [basename(home)]: { threadId,title:"Empty completion",turnsFile,threadMetadataFile } } },
      pollIntervalMs: 250,
    });
    await adapter.waitForReady(5_000);
    await waitUntil(() => events.some(event => event.kind === "session_start" &&
      event.codexControl?.activeTurnId === turnId));

    writeFileSync(turnsFile, JSON.stringify([{
      id:turnId,status:"completed",startedAt:1_800_000_001,completedAt:1_800_000_002,
      items:[{type:"userMessage",content:[{type:"text",text:"still running"}]}],
    }]));
    writeFileSync(threadMetadataFile, JSON.stringify({ updatedAt:1_800_000_001 }));
    await waitUntil(() => events.some(event => event.kind === "session_start" &&
      event.codexControl?.activeTurnId === null && event.ts >= 1_800_000_001));
    expect(events.filter(event => event.kind === "session_start" && event.codexControl?.activeTurnId === null))
      .toHaveLength(1);
    expect(events.some(event => event.kind === "response" && event.sessionId === sessionIdFor("EmptyCompletion",threadId)))
      .toBe(false);
  }, 10_000);
  test("retains hydrated metadata and publishes updates with unchanged turns", async () => {
    const home = makeHome("hydrated-metadata-home"), threadId = "hydrated_metadata_thread";
    const summaryPath = join(home,"summary.json"), hydratedPath = join(home,"hydrated.json");
    writeFileSync(summaryPath,JSON.stringify({ name:"List summary title",cwd:"/summary",updatedAt:1_800_000_000 }));
    writeFileSync(hydratedPath,JSON.stringify({ name:"Hydrated thread title",cwd:"/hydrated",updatedAt:1_800_000_000 }));
    const { adapter, events } = startAdapter({
      identities:[{accountAlias:"HydratedMetadata",codeHome:home}],
      fixture:{profiles:{[basename(home)]:{
        threadId,title:"Default summary",threadListMetadataFile:summaryPath,threadReadMetadataFile:hydratedPath,
      }}},
      pollIntervalMs:250,
    });
    await adapter.waitForReady(5_000);
    const sessionId = sessionIdFor("HydratedMetadata",threadId);
    await waitUntil(() => events.some(event => event.kind === "session_start" &&
      event.sessionId === sessionId && event.title === "Hydrated thread title"));
    await waitUntil(() => readRpc(home).filter(request => request.method === "thread/list").length >= 4);
    const initialStarts = events.filter(event => event.kind === "session_start" && event.sessionId === sessionId);
    expect(initialStarts).toHaveLength(1);
    expect(initialStarts[0]).toMatchObject({ title:"Hydrated thread title",cwd:"/hydrated" });

    writeFileSync(summaryPath,JSON.stringify({ name:"Updated list title",cwd:"/updated-summary",updatedAt:1_800_000_001 }));
    writeFileSync(hydratedPath,JSON.stringify({ name:"Updated hydrated title",cwd:"/updated-hydrated",updatedAt:1_800_000_001 }));
    await waitUntil(() => events.some(event => event.kind === "session_start" &&
      event.sessionId === sessionId && event.title === "Updated hydrated title"));
    const updatedStarts = events.filter(event => event.kind === "session_start" && event.sessionId === sessionId);
    expect(updatedStarts).toHaveLength(2);
    expect(updatedStarts[1]).toMatchObject({ title:"Updated hydrated title",cwd:"/updated-hydrated" });
  }, 10_000);

  test("waitForReady resolves when one identity is ready and another remains offline", async () => {
    const readyHome = makeHome("one-ready-home");
    const missingHome = join(temporaryRoot,"missing-profile-home");
    const threadId = "one_ready_thread";
    const { adapter, events } = startAdapter({
      identities: [
        { accountAlias:"Ready",codeHome:readyHome },
        { accountAlias:"Offline",codeHome:missingHome },
      ],
      fixture: { profiles: {
        [basename(readyHome)]: { threadId,title:"Ready profile" },
        [basename(missingHome)]: { threadId:"offline_thread",title:"Offline profile" },
      } },
      pollIntervalMs: 250,
      retryDelayMs: 50,
    });
    await adapter.waitForReady(5_000);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === sessionIdFor("Ready",threadId)));
    expect(adapter.health().enabled).toBe(true);
    expect(adapter.health().identities[0]?.state).toBe("ready");
    expect(adapter.health().identities[1]?.state).not.toBe("ready");
  }, 10_000);


  test("thread-local read failures keep the identity process ready and use available summary metadata", async () => {
    const home = makeHome("thread-read-failure-home");
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"Failure",codeHome:home }],
      fixture: {
        profiles: { [basename(home)]: { threadId:"failure_thread",title:"Summary remains visible" } },
        failRequests: ["thread/read","thread/turns/list"],
      },
      pollIntervalMs: 250,
    });
    await adapter.waitForReady(5_000);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.title === "Summary remains visible") &&
      readRpc(home).some(request => request.method === "thread/loaded/list"));
    expect(adapter.health().identities[0]?.state).toBe("ready");
    expect(launchCount(home)).toBe(1);
  }, 10_000);

  test("runtime-rejected turn/start is downgraded and receives an unsupported receipt", async () => {
    const home = makeHome("start-unsupported-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "start_unsupported_thread";
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"StartUnsupported",codeHome:home }],
      hub,
      fixture: {
        profiles: { [basename(home)]: { threadId,title:"Start unsupported" } },
        unsupportedMethods: ["turn/start"],
      },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("StartUnsupported", threadId);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session) && hub.waitSessions.has(session));
    const target = sessionKey("codex-test-host", session);
    hub.enqueue(session, { id: 905, target, action:"turn/start", text:"do not send" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 905) &&
      events.some(event => event.kind === "error" && event.detail === "unsupported_method" && event.sessionId === session));
    expect(hub.receipts.find(receipt => receipt.id === 905)).toMatchObject({ outcome:"unsupported",reason:"unsupported_method" });
    expect(events.find(event => event.kind === "error" && event.detail === "unsupported_method")?.codexControl?.turnStart).toBe(false);
    expect(readRpc(home).filter(request => request.method === "turn/start")).toHaveLength(1);
  }, 10_000);


  test("resumes a listed unloaded vscode-source thread before starting and then marks it owned", async () => {
    const home = makeHome("resume-unloaded-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "resume_unloaded_thread";
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"ResumeUnloaded",codeHome:home }],
      hub,
      fixture: {
        profiles: { [basename(home)]: { threadId,title:"Resume unloaded",turns:[] } },
        loadedThreads: [],
      },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("ResumeUnloaded",threadId);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session &&
      event.codexControl?.source === "vscode" && event.codexControl.appServerOwned === false) && hub.waitSessions.has(session));
    const target = sessionKey("codex-test-host",session);
    hub.enqueue(session,{ id:906,target,action:"turn/start",text:"start after resume" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 906));
    expect(hub.receipts.find(receipt => receipt.id === 906)).toMatchObject({ outcome:"accepted" });
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session &&
      event.codexControl?.appServerOwned === true));
    const requests = readRpc(home);
    const resumeIndex = requests.findIndex(request => request.method === "thread/resume");
    const startIndex = requests.findIndex(request => request.method === "turn/start");
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(resumeIndex).toBeLessThan(startIndex);
    expect(requests.filter(request => request.method === "turn/start")).toHaveLength(1);
  }, 10_000);


  test("resume rejection returns an honest failure without starting or claiming ownership", async () => {
    const home = makeHome("resume-rejected-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "resume_rejected_thread";
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"ResumeRejected",codeHome:home }],
      hub,
      fixture: {
        profiles: { [basename(home)]: { threadId,title:"Resume rejected",turns:[] } },
        loadedThreads: [],
        failRequests: ["thread/resume"],
        failRequestMessages: { "thread/resume":"Thread is currently active in another app-server" },
      },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("ResumeRejected",threadId);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session &&
      event.codexControl?.appServerOwned === false) && hub.waitSessions.has(session));
    hub.enqueue(session,{ id:907,target:sessionKey("codex-test-host",session),action:"turn/start",text:"must not start" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 907));
    expect(hub.receipts.find(receipt => receipt.id === 907)).toMatchObject({
      outcome:"failed",reason:"thread_active_elsewhere",
    });
    expect(readRpc(home).filter(request => request.method === "thread/resume")).toHaveLength(1);
    expect(readRpc(home).filter(request => request.method === "turn/start")).toHaveLength(0);
    expect(events.some(event => event.kind === "session_start" && event.sessionId === session &&
      event.codexControl?.appServerOwned === true)).toBe(false);
  }, 10_000);

  test("a loaded vscode-source thread is owned immediately", async () => {
    const home = makeHome("loaded-vscode-home");
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"LoadedVscode",codeHome:home }],
      fixture: { profiles: { [basename(home)]: { threadId:"loaded_vscode_thread",title:"Loaded vscode" } } },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("LoadedVscode","loaded_vscode_thread");
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session));
    expect(events.find(event => event.kind === "session_start" && event.sessionId === session)?.codexControl)
      .toMatchObject({ source:"vscode",appServerOwned:true });
  }, 10_000);
  test("restart clears adapter ownership before steering an unowned thread", async () => {
    const home = makeHome("owned-restart-home"), hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "owned_restart_thread", turnId = "owned_restart_turn";
    const turnsFile = join(home,"turns.json");
    writeFileSync(turnsFile,"[]");
    const children: ChildProcess[] = [];
    const { adapter, events } = startAdapter({
      identities:[{accountAlias:"OwnedRestart",codeHome:home}],
      hub,
      fixture:{profiles:{[basename(home)]:{
        threadId,title:"Restart ownership",turnsFile,
        turnAfterStart:activeTurn(turnId,"turn before restart"),
      }},loadedThreads:[]},
      spawnImpl:(command,args,spawnOptions) => {
        const child = spawn(command,args,spawnOptions);
        children.push(child);
        return child;
      },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("OwnedRestart",threadId), target = sessionKey("codex-test-host",session);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session &&
      event.codexControl?.appServerOwned === false) && hub.waitSessions.has(session));
    hub.enqueue(session,{ id:950,target,action:"turn/start",text:"turn before restart" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 950));
    expect(hub.receipts.find(receipt => receipt.id === 950)).toMatchObject({ outcome:"accepted" });
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session &&
      event.codexControl?.appServerOwned === true));
    expect(readRpc(home).filter(request => request.method === "thread/resume")).toHaveLength(1);
    expect(children).toHaveLength(1);

    const eventCount = events.length;
    children[0]!.kill("SIGTERM");
    await waitUntil(() => children.length > 1 && events.slice(eventCount).some(event => event.kind === "session_start" &&
      event.sessionId === session && event.codexControl?.appServerOwned === false));
    hub.enqueue(session,{ id:951,target,action:"turn/steer",text:"must not steer after restart",expectedTurnId:turnId });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 951));
    expect(hub.receipts.find(receipt => receipt.id === 951)).toMatchObject({
      outcome:"failed",reason:"codex_not_owned",
    });
    expect(readRpc(home).filter(request => request.method === "turn/steer")).toHaveLength(0);
  }, 10_000);

  test("does not send turn/start while a Codex turn is already active", async () => {
    const home = makeHome("active-start-guard-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "active_start_guard_thread";
    const turnId = "guarded_active_turn";
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"ActiveGuard",codeHome:home }],
      hub,
      fixture: { profiles: { [basename(home)]: {
        threadId,title:"Already active",turns:[activeTurn(turnId,"already running")],
      } } },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("ActiveGuard",threadId);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session &&
      event.codexControl?.activeTurnId === turnId) && hub.waitSessions.has(session));
    const target = sessionKey("codex-test-host",session);
    hub.enqueue(session,{ id:908,target,action:"turn/start",text:"do not start over active turn" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 908));
    expect(hub.receipts.find(receipt => receipt.id === 908)).toMatchObject({
      outcome:"failed",reason:"turn_active",
    });
    expect(readRpc(home).filter(request => request.method === "turn/start")).toHaveLength(0);
  }, 10_000);
  test("reserves an accepted turn/start until sync observes the new turn", async () => {
    const home = makeHome("start-reservation-home"), hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "start_reservation_thread", turnId = "reserved_turn";
    const turnsFile = join(home,"turns.json");
    writeFileSync(turnsFile,"[]");
    const { adapter, events } = startAdapter({
      identities:[{accountAlias:"StartReservation",codeHome:home}],
      hub,
      fixture:{profiles:{[basename(home)]:{
        // Keep the post-start turns read in flight so the second queued delivery tests the local reservation.
        threadId,title:"Start reservation",turnsFile,turnsDelayMs:700,
        turnAfterStart:activeTurn(turnId,"reserved prompt"),
      }}},
      requestTimeoutMs:5_000,
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("StartReservation",threadId), target = sessionKey("codex-test-host",session);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session) &&
      hub.waitSessions.has(session));
    hub.enqueue(session,{ id:930,target,action:"turn/start",text:"first start" });
    hub.enqueue(session,{ id:931,target,action:"turn/start",text:"duplicate start" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 930) && hub.receipts.some(receipt => receipt.id === 931));
    await waitUntil(() => events.some(event => event.kind === "session_start" &&
      event.sessionId === session && event.codexControl?.activeTurnId === turnId));
    expect(hub.receipts.find(receipt => receipt.id === 930)).toMatchObject({ outcome:"accepted" });
    expect(hub.receipts.find(receipt => receipt.id === 931)).toMatchObject({ outcome:"failed",reason:"turn_start_pending" });
    expect(readRpc(home).filter(request => request.method === "turn/start")).toHaveLength(1);
  }, 10_000);
  test("keeps a start reservation when an unrelated turn starts and completes", async () => {
    const home = makeHome("unrelated-start-reservation-home"), hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "unrelated_start_reservation_thread", turnId = "unrelated_reservation_turn";
    const turnsFile = join(home, "turns.json");
    writeFileSync(turnsFile, "[]");
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"UnrelatedReservation",codeHome:home }],
      hub,
      fixture: { profiles: { [basename(home)]: { threadId,title:"Unrelated reservation",turnsFile } } },
      pollIntervalMs: 250,
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("UnrelatedReservation",threadId), target = sessionKey("codex-test-host",session);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session) &&
      hub.waitSessions.has(session));
    hub.enqueue(session,{ id:936,target,action:"turn/start",text:"reserved prompt" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 936 && receipt.outcome === "accepted"));

    const unrelatedPrompt = "independent prompt";
    writeFileSync(turnsFile, JSON.stringify([activeTurn(turnId, unrelatedPrompt)]));
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session &&
      event.codexControl?.activeTurnId === turnId));
    writeFileSync(turnsFile, JSON.stringify([completedTurn(turnId, unrelatedPrompt, "unrelated output")]));
    await waitUntil(() => events.some(event => event.kind === "response" && event.sessionId === session && event.text === "unrelated output") &&
      events.some(event => event.kind === "session_start" && event.sessionId === session && event.codexControl?.activeTurnId === null));

    hub.enqueue(session,{ id:937,target,action:"turn/start",text:"duplicate start after unrelated turn" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 937));
    expect(hub.receipts.find(receipt => receipt.id === 937)).toMatchObject({
      outcome:"failed",reason:"turn_start_pending",
    });
    expect(readRpc(home).filter(request => request.method === "turn/start")).toHaveLength(1);
  }, 10_000);

  test("expired start reservations do not block a later start forever", async () => {
    const home = makeHome("expired-start-reservation-home"), hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "expired_start_reservation_thread";
    let currentTime = 1_800_000_000_000;
    const { adapter, events } = startAdapter({
      identities:[{accountAlias:"ExpiredReservation",codeHome:home}],
      hub,
      now:() => currentTime,
      pollIntervalMs:250,
      requestTimeoutMs:1_000,
      fixture:{
        profiles:{[basename(home)]:{threadId,title:"Expired start reservation"}},
        timeoutMethods:["turn/start"],
      },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("ExpiredReservation",threadId), target = sessionKey("codex-test-host",session);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session) &&
      hub.waitSessions.has(session));
    hub.enqueue(session,{ id:934,target,action:"turn/start",text:"first uncertain start" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 934));
    expect(hub.receipts.find(receipt => receipt.id === 934)).toMatchObject({ outcome:"unknown",reason:"request_timeout" });
    currentTime += 60_001;
    hub.enqueue(session,{ id:935,target,action:"turn/start",text:"start after reservation expiry" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 935));
    expect(hub.receipts.find(receipt => receipt.id === 935)).toMatchObject({ outcome:"unknown",reason:"request_timeout" });
    expect(readRpc(home).filter(request => request.method === "turn/start")).toHaveLength(2);
  }, 10_000);
  test("releases a start reservation after completion when its initial turns read failed", async () => {
    const home = makeHome("unknown-start-baseline-home"), hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "unknown_start_baseline_thread";
    const turnsFile = join(home,"turns.json");
    writeFileSync(turnsFile,"[]");
    const { adapter, events } = startAdapter({
      identities:[{accountAlias:"UnknownBaseline",codeHome:home}],
      hub,
      now:() => 1_800_000_000_000,
      fixture:{profiles:{[basename(home)]:{
        threadId,title:"Unknown baseline",turnsFile,
        turnAfterStart:completedTurn("unknown_baseline_turn","start after unknown baseline","completed answer"),
      }},failOnceMethods:["thread/turns/list"]},
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("UnknownBaseline",threadId), target = sessionKey("codex-test-host",session);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session) &&
      hub.waitSessions.has(session));

    hub.enqueue(session,{ id:932,target,action:"turn/start",text:"start after unknown baseline" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 932));
    expect(hub.receipts.find(receipt => receipt.id === 932)).toMatchObject({ outcome:"accepted" });
    await waitUntil(() => events.some(event => event.kind === "response" && event.sessionId === session));
    const completedResponse = events.find(event => event.kind === "response" && event.text === "completed answer");
    expect(completedResponse?.responseSource).toBeUndefined();
    const db = new DashDB(":memory:");
    try {
      db.applyEvent(completedResponse!);
      expect(db.getSession(sessionKey("codex-test-host",session))?.unreadCount).toBe(1);
    } finally { db.close(); }

    hub.enqueue(session,{ id:933,target,action:"turn/start",text:"start again after completion" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 933));
    expect(hub.receipts.find(receipt => receipt.id === 933)).toMatchObject({ outcome:"accepted" });
    expect(readRpc(home).filter(request => request.method === "turn/start")).toHaveLength(2);
  }, 10_000);

  test("sends a Codex control only to its matching identity and records the accepted receipt", async () => {
    const alphaHome = makeHome("alpha-home");
    const betaHome = makeHome("beta-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "isolated_thread";
    const { adapter, events } = startAdapter({
      identities: [
        { accountAlias: "Alpha", codeHome: alphaHome },
        { accountAlias: "Beta", codeHome: betaHome },
      ],
      hub,
      fixture: { profiles: {
        [basename(alphaHome)]: { threadId, title: "Alpha control", turns: [] },
        [basename(betaHome)]: { threadId, title: "Beta control", turns: [] },
      }, loadedThreads: [] },
    });
    await adapter.waitForReady(5_000);

    const alphaSession = sessionIdFor("Alpha", threadId);
    const betaSession = sessionIdFor("Beta", threadId);
    await waitUntil(() =>
      events.some(event => event.kind === "session_start" && event.accountAlias === "Alpha") &&
      events.some(event => event.kind === "session_start" && event.accountAlias === "Beta") &&
      hub.waitSessions.has(alphaSession) && hub.waitSessions.has(betaSession));
    const target = sessionKey("codex-test-host", alphaSession);
    hub.enqueue(alphaSession, { id: 901, target, action: "turn/start", text: "send only to Alpha" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 901));

    expect(hub.commits.some(commit => commit.id === 901 && commit.target === target)).toBe(true);
    expect(hub.receipts.find(receipt => receipt.id === 901)).toMatchObject({
      id: 901, target, outcome: "accepted",
    });
    const alphaStarts = readRpc(alphaHome).filter(request => request.method === "turn/start");
    const betaStarts = readRpc(betaHome).filter(request => request.method === "turn/start");
    expect(alphaStarts).toHaveLength(1);
    expect(alphaStarts[0]?.params).toEqual({
      threadId, input: [{ type: "text", text: "send only to Alpha" }], clientUserMessageId: "dash-901",
    });
    expect(readRpc(alphaHome).filter(request => request.method === "thread/resume")).toHaveLength(1);
    expect(readRpc(betaHome).filter(request => request.method === "thread/resume")).toHaveLength(0);
    expect(betaStarts).toHaveLength(0);
  }, 10_000);

  test("interrupts a supported active turn and reports an accepted receipt", async () => {
    const home = makeHome("interrupt-supported-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "interrupt_thread";
    const turnId = "active_turn";
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias: "Interrupt", codeHome: home }],
      hub,
      fixture: { profiles: { [basename(home)]: {
        threadId, title: "Interrupt me", turns: [activeTurn(turnId, "still working")],
      } } },
    });
    await adapter.waitForReady(5_000);

    const session = sessionIdFor("Interrupt", threadId);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session) && hub.waitSessions.has(session));
    expect(events.find(event => event.kind === "session_start" && event.sessionId === session)?.codexControl?.turnInterrupt).toBe(true);
    const target = sessionKey("codex-test-host", session);
    hub.enqueue(session, { id: 902, target, action: "turn/interrupt", expectedTurnId: turnId });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 902));

    expect(hub.receipts.find(receipt => receipt.id === 902)).toMatchObject({ id: 902, target, outcome: "accepted" });
    expect(readRpc(home).find(request => request.method === "turn/interrupt")?.params).toEqual({ threadId, turnId });
  }, 10_000);
  test("steers the observed active turn and reports the accepted receipt", async () => {
    const home = makeHome("steer-supported-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "steer_thread", turnId = "steer_active_turn";
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"Steer",codeHome:home }],
      hub,
      fixture: { profiles: { [basename(home)]: {
        threadId, title:"Steer this turn", turns:[activeTurn(turnId,"still working")],
      } } },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("Steer", threadId), target = sessionKey("codex-test-host", session);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session) && hub.waitSessions.has(session));
    expect(events.find(event => event.kind === "session_start" && event.sessionId === session)?.codexControl?.turnSteer).toBe(true);
    hub.enqueue(session, { id:913,target,action:"turn/steer",text:"continue carefully",expectedTurnId:turnId });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 913));
    expect(hub.receipts.find(receipt => receipt.id === 913)).toMatchObject({ outcome:"accepted",target });
    expect(readRpc(home).find(request => request.method === "turn/steer")?.params).toEqual({
      threadId,input:[{type:"text",text:"continue carefully"}],expectedTurnId:turnId,clientUserMessageId:"dash-913",
    });
  }, 10_000);
  test("preserves stale_turn from an app-server steer rejection", async () => {
    const home = makeHome("stale-steer-home"), hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "stale_steer_thread", turnId = "stale_steer_active_turn";
    const { adapter } = startAdapter({
      identities:[{accountAlias:"StaleSteer",codeHome:home}],
      hub,
      fixture:{
        profiles:{[basename(home)]:{threadId,title:"Stale steer",turns:[activeTurn(turnId,"still running")]}},
        failRequests:["turn/steer"],
        failRequestMessages:{"turn/steer":"Turn is not active"},
      },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("StaleSteer",threadId), target = sessionKey("codex-test-host",session);
    await waitUntil(() => hub.waitSessions.has(session));
    hub.enqueue(session,{ id:932,target,action:"turn/steer",text:"stale steer",expectedTurnId:turnId });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 932));
    expect(hub.receipts.find(receipt => receipt.id === 932)).toMatchObject({
      outcome:"failed",reason:"stale_turn",
    });
  }, 10_000);


  test("does not send version-unsupported interrupts and reports unsupported honestly", async () => {
    const home = makeHome("interrupt-old-version-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "old_version_thread";
    const turnId = "old_active_turn";
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias: "OldVersion", codeHome: home }],
      hub,
      fixture: { profiles: { [basename(home)]: {
        threadId, title: "Older app-server", version: "codex-cli/0.159.9", turns: [activeTurn(turnId, "still working")],
      } } },
    });
    await adapter.waitForReady(5_000);

    const session = sessionIdFor("OldVersion", threadId);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session) && hub.waitSessions.has(session));
    expect(events.find(event => event.kind === "session_start" && event.sessionId === session)?.codexControl)
      .toMatchObject({ turnStart:false,turnSteer:false,turnInterrupt:false });
    const target = sessionKey("codex-test-host", session);
    hub.enqueue(session, { id: 903, target, action: "turn/interrupt", expectedTurnId: turnId });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 903));

    expect(hub.receipts.find(receipt => receipt.id === 903)).toMatchObject({
      id: 903, target, outcome: "unsupported", reason: "unsupported_method",
    });
    expect(readRpc(home).some(request => request.method === "turn/interrupt")).toBe(false);
  }, 10_000);

  test("downgrades a runtime-rejected interrupt and acknowledges unsupported", async () => {
    const home = makeHome("interrupt-rejected-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "rejected_interrupt_thread";
    const turnId = "rejected_active_turn";
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias: "RejectingServer", codeHome: home }],
      hub,
      fixture: {
        profiles: { [basename(home)]: { threadId, title: "Rejects interrupt", turns: [activeTurn(turnId, "still working")] } },
        unsupportedMethods: ["turn/interrupt"],
      },
    });
    await adapter.waitForReady(5_000);

    const session = sessionIdFor("RejectingServer", threadId);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session) && hub.waitSessions.has(session));
    expect(events.find(event => event.kind === "session_start" && event.sessionId === session)?.codexControl?.turnInterrupt).toBe(true);
    const target = sessionKey("codex-test-host", session);
    hub.enqueue(session, { id: 904, target, action: "turn/interrupt", expectedTurnId: turnId });
    await waitUntil(() =>
      hub.receipts.some(receipt => receipt.id === 904) &&
      events.some(event => event.kind === "error" && event.detail === "unsupported_method" && event.sessionId === session));

    expect(hub.receipts.find(receipt => receipt.id === 904)).toMatchObject({
      id: 904, target, outcome: "unsupported", reason: "unsupported_method",
    });
    expect(events.find(event => event.kind === "error" && event.detail === "unsupported_method" && event.sessionId === session)?.codexControl?.turnInterrupt).toBe(false);
    expect(readRpc(home).some(request => request.method === "turn/interrupt")).toBe(true);
  }, 10_000);

  test("retries a failed liveness heartbeat and refreshes unchanged source records", async () => {
    const home = makeHome("liveness-heartbeat-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    hub.livenessFailuresRemaining = 1;
    let time = 1_000;
    const { adapter } = startAdapter({
      identities: [{ accountAlias:"Heartbeat",codeHome:home }],
      hub,
      fixture: { profiles: { [basename(home)]: { threadId:"heartbeat_thread",title:"Heartbeat session" } } },
      pollIntervalMs: 250,
      now: () => time,
    });
    await adapter.waitForReady(5_000);
    await waitUntil(() => hub.livenessAttempts.length >= 2 && hub.livenessReports.length >= 1);
    expect(hub.livenessReports).toHaveLength(1);
    const delivered = hub.livenessReports.length;
    await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 25));
    time += 60_001;
    await waitUntil(() => hub.livenessReports.length > delivered);
    expect(hub.livenessReports.at(-1)).toEqual(hub.livenessReports[delivered - 1]);
  }, 10_000);

  test("a timed-out Codex control RPC reports unknown and is never automatically replayed", async () => {
    const home = makeHome("control-timeout-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "control_timeout_thread";
    const { adapter } = startAdapter({
      identities: [{ accountAlias:"Timeout",codeHome:home }],
      hub,
      fixture: { profiles: { [basename(home)]: { threadId,title:"Timed out control" } }, timeoutMethods:["turn/start"] },
      requestTimeoutMs:250,
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("Timeout", threadId), target = sessionKey("codex-test-host", session);
    await waitUntil(() => hub.waitSessions.has(session));
    hub.enqueue(session, { id:922,target,action:"turn/start",text:"possibly dispatched" });
    await waitUntil(() => readRpc(home).some(request => request.method === "turn/start"));
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 922));

    expect(hub.receipts.find(receipt => receipt.id === 922)).toMatchObject({
      id:922,target,outcome:"unknown",reason:"request_timeout",
    });
    expect(readRpc(home).filter(request => request.method === "turn/start")).toHaveLength(1);
  }, 10_000);

  test("a Codex app-server exit after a control RPC write reports unknown without replay", async () => {
    const home = makeHome("control-exit-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "control_exit_thread";
    const { adapter } = startAdapter({
      identities: [{ accountAlias:"Exit",codeHome:home }],
      hub,
      fixture: { profiles: { [basename(home)]: { threadId,title:"Exited during control" } }, exitMethods:["turn/start"] },
      requestTimeoutMs:5_000,
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("Exit", threadId), target = sessionKey("codex-test-host", session);
    await waitUntil(() => hub.waitSessions.has(session));
    hub.enqueue(session, { id:923,target,action:"turn/start",text:"possibly dispatched before exit" });
    await waitUntil(() => readRpc(home).some(request => request.method === "turn/start"));
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 923));

    expect(hub.receipts.find(receipt => receipt.id === 923)).toMatchObject({
      id:923,target,outcome:"unknown",reason:"request_interrupted",
    });
    expect(readRpc(home).filter(request => request.method === "turn/start")).toHaveLength(1);
  }, 10_000);
  test("handles asynchronous app-server stdin errors as unknown without replaying controls", async () => {
    const home = makeHome("stdin-error-home"), hub = new FakeControlHub();
    activeHub = hub;
    const threadId = "stdin_error_thread", methods: string[] = [];
    let failStart = true;
    const syntheticSpawn = (() => {
      const stdin = new PassThrough(), stdout = new PassThrough();
      let child: EventEmitter & {
        stdin: PassThrough; stdout: PassThrough; stderr: null; pid: number;
        exitCode: number | null; signalCode: null; kill: () => boolean;
      };
      let exitScheduled = false;
      child = Object.assign(new EventEmitter(), {
        stdin, stdout, stderr:null, pid:1, exitCode:null as number | null, signalCode:null,
        kill: () => {
          if (!exitScheduled) {
            exitScheduled = true;
            setImmediate(() => {
              child.exitCode = 0;
              stdin.end(); stdout.end();
              child.emit("exit",0,null);
            });
          }
          return true;
        },
      });
      const thread = { id:threadId,name:"stdin error",cwd:"/fake",source:"appServer",status:{type:"active"},updatedAt:1_800_000_000 };
      let buffer = "";
      stdin.on("data", chunk => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0,newline);
          buffer = buffer.slice(newline + 1);
          const request = JSON.parse(line) as Record<string, unknown>;
          const method = typeof request.method === "string" ? request.method : "";
          if (!method) continue;
          methods.push(method);
          if (method === "turn/start" && failStart) {
            failStart = false;
            setImmediate(() => stdin.emit("error",Object.assign(new Error("synthetic broken pipe"),{code:"EPIPE"})));
            continue;
          }
          if (request.id === undefined) continue;
          const params = request.params as Record<string, unknown> | undefined;
          const result = method === "initialize" ? { userAgent:"codex-cli/0.160.0" }
            : method === "thread/list" ? { data:params?.archived === true ? [] : [thread] }
              : method === "thread/loaded/list" ? { data:[threadId] }
                : method === "thread/read" ? { thread }
                  : method === "thread/turns/list" ? { data:[] }
                    : method === "thread/resume" ? { thread } : {};
          stdout.write(`${JSON.stringify({ id:request.id,result })}\n`);
        }
      });
      return child as unknown as ChildProcess;
    }) as NonNullable<CodexAdapterOptions["spawnImpl"]>;
    const { adapter } = startAdapter({
      identities:[{accountAlias:"StdinError",codeHome:home}],
      fixture:{profiles:{}},
      hub,
      spawnImpl:syntheticSpawn,
      requestTimeoutMs:5_000,
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("StdinError",threadId), target = sessionKey("codex-test-host",session);
    await waitUntil(() => hub.waitSessions.has(session));
    hub.enqueue(session,{ id:933,target,action:"turn/start",text:"possibly sent before EPIPE" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 933));
    expect(hub.receipts.find(receipt => receipt.id === 933)).toMatchObject({
      outcome:"unknown",reason:"request_interrupted",
    });
    expect(methods.filter(method => method === "turn/start")).toHaveLength(1);
  }, 10_000);

  test("control poller survives commit transport failure without replaying a possibly committed action", async () => {
    const home = makeHome("commit-retry-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    let commitAttempts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/reply/commit" && ++commitAttempts === 1) {
        changes.notify();
        throw new TypeError("synthetic transport failure");
      }
      return fetch(input, init);
    };
    const threadId = "commit_retry_thread";
    const { adapter } = startAdapter({
      identities: [{ accountAlias:"CommitRetry",codeHome:home }],
      hub,
      fetchImpl,
      fixture: { profiles: { [basename(home)]: { threadId,title:"Commit retry" } } },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("CommitRetry", threadId), target = sessionKey("codex-test-host", session);
    await waitUntil(() => hub.waitSessions.has(session));
    hub.enqueue(session, { id:910,target,action:"turn/start",text:"possibly lost but never duplicated" });
    await waitUntil(() => commitAttempts === 1);
    hub.enqueue(session, { id:911,target,action:"turn/start",text:"poller remains alive" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 911));
    expect(hub.receipts.find(receipt => receipt.id === 911)).toMatchObject({ outcome:"accepted",target });
    expect(readRpc(home).filter(request => request.method === "turn/start").map(request => request.params?.clientUserMessageId)).toEqual(["dash-911"]);
    expect(adapter.health().identities[0]?.state).toBe("ready");
  }, 10_000);
  test("terminal receipt rejection does not stop later control delivery", async () => {
    const home = makeHome("ack-terminal-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    hub.ackStatus = 404;
    const threadId = "ack_terminal_thread";
    const turnsFile = join(home,"ack-terminal-turns.json");
    writeFileSync(turnsFile,"[]");
    const { adapter, events } = startAdapter({
      identities: [{ accountAlias:"AckTerminal",codeHome:home }],
      hub,
      fixture: { profiles: { [basename(home)]: {
        threadId,title:"Terminal ack",turnsFile,
        turnAfterStart:completedTurn("ack_terminal_turn_1","first terminal receipt","first completed output"),
      } } },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("AckTerminal", threadId), target = sessionKey("codex-test-host", session);
    await waitUntil(() => hub.waitSessions.has(session));
    hub.enqueue(session, { id:920,target,action:"turn/start",text:"first terminal receipt" });
    await waitUntil(() => hub.receiptAttempts.some(receipt => receipt.id === 920));
    await waitUntil(() => events.some(event => event.kind === "response" && event.sessionId === session));
    hub.enqueue(session, { id:921,target,action:"turn/start",text:"poller keeps working" });
    await waitUntil(() => hub.receiptAttempts.some(receipt => receipt.id === 921));
    expect(hub.receiptAttempts.map(receipt => receipt.id)).toEqual([920,921]);
    expect(readRpc(home).filter(request => request.method === "turn/start")
      .map(request => request.params?.clientUserMessageId)).toEqual(["dash-920","dash-921"]);
    expect(adapter.health().identities[0]?.state).toBe("ready");
  }, 10_000);

  test("a transient discovery failure does not restart the app-server", async () => {
    const home = makeHome("transient-discovery-home");
    const threadId = "transient_discovery_thread";
    const { adapter } = startAdapter({
      identities: [{ accountAlias:"Discovery",codeHome:home }],
      fixture: {
        profiles: { [basename(home)]: { threadId,title:"Active discovery failure",turns:[activeTurn("still_running_turn","still running")] } },
        failAfterInitialSync: ["thread/list"],
      },
      pollIntervalMs: 250,
      restartDelayMs: 50,
    });
    await adapter.waitForReady(5_000);
    await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 800));
    expect(adapter.health().identities[0]?.state).toBe("ready");
    expect(launchCount(home)).toBe(1);
    expect(readRpc(home).filter(request => request.method === "thread/list").length).toBeGreaterThanOrEqual(4);
    expect(readRpc(home).some(request => request.method === "thread/turns/list")).toBe(true);
  }, 10_000);


  test("retries only the target receipt after a transient acknowledgement failure", async () => {
    const home = makeHome("ack-retry-home");
    const hub = new FakeControlHub();
    activeHub = hub;
    hub.ackFailuresRemaining = 1;
    const threadId = "ack_retry_thread";
    const { adapter } = startAdapter({
      identities: [{ accountAlias:"AckRetry",codeHome:home }],
      hub,
      fixture: { profiles: { [basename(home)]: { threadId,title:"Ack retry" } } },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("AckRetry", threadId), target = sessionKey("codex-test-host", session);
    await waitUntil(() => hub.waitSessions.has(session));
    hub.enqueue(session, { id:912,target,action:"turn/start",text:"one app-server action" });
    await waitUntil(() => hub.receipts.some(receipt => receipt.id === 912));
    expect(hub.receiptAttempts.filter(receipt => receipt.id === 912)).toHaveLength(2);
    expect(hub.receipts.filter(receipt => receipt.id === 912)).toHaveLength(1);
    expect(hub.commits.filter(commit => commit.id === 912)).toHaveLength(1);
    expect(readRpc(home).filter(request => request.method === "turn/start")).toHaveLength(1);
  }, 10_000);

  test("publishes liveness loss on child crash and restores it after restart", async () => {
    const home = makeHome("restart-home");
    const threadId = "restart_thread";
    const { adapter, events, liveness } = startAdapter({
      identities: [{ accountAlias: "Restart", codeHome: home }],
      fixture: {
        profiles: { [basename(home)]: { threadId, title: "Restart session", turns: [] } },
        crashFirstLaunch: true,
        crashDelayMs: 1_000,
      },
      restartDelayMs: 50,
    });
    await adapter.waitForReady(5_000);

    const session = sessionIdFor("Restart", threadId);
    await waitUntil(() => events.some(event => event.kind === "session_start" && event.sessionId === session) &&
      liveness.some(records => records.some(record => record.sessionId === session)));
    await waitUntil(() => adapter.health().identities[0]?.state === "offline" && liveness.some(records => records.length === 0));
    const lossIndex = liveness.findIndex(records => records.length === 0);
    await waitUntil(() => launchCount(home) >= 2 && adapter.health().identities[0]?.state === "ready" &&
      liveness.some((records, index) => index > lossIndex && records.some(record => record.sessionId === session)));

    expect(launchCount(home)).toBe(2);
    expect(liveness[lossIndex]).toEqual([]);
    expect(liveness.slice(lossIndex + 1).some(records => records.some(record => record.sessionId === session))).toBe(true);
  }, 10_000);
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
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
  threadMetadataFile?: string;
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
  failRequests?: string[];
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
}): { adapter: CodexAdapter; events: NormalizedEvent[]; liveness: LivenessRecord[][] } {
  const events: NormalizedEvent[] = [];
  const liveness: LivenessRecord[][] = [];
  const spawnImpl = ((command: string, args: readonly string[], spawnOptions?: SpawnOptions) => {
    const childOptions: SpawnOptions = {
      ...spawnOptions,
      env: { ...spawnOptions?.env, HOME: temporaryRoot, TMPDIR: temporaryRoot },
    };
    const child = spawn(command, args, childOptions);
    spawnedChildren.push(child);
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
      events.some(event => event.kind === "response" && event.accountAlias === "Alpha") &&
      events.some(event => event.kind === "response" && event.accountAlias === "Beta") &&
      liveness.some(records => records.some(record => record.sessionId === alphaSession) &&
        records.some(record => record.sessionId === betaSession)));

    const alphaStart = events.find(event => event.kind === "session_start" && event.accountAlias === "Alpha");
    const betaStart = events.find(event => event.kind === "session_start" && event.accountAlias === "Beta");
    expect(alphaStart).toMatchObject({
      host: "codex-test-host", harness: "codex", sessionId: alphaSession, title: "Alpha history", cwd: "/fake/alpha",
      accountAlias: "Alpha", codexControl: { source: "appServer", appServerOwned: true, turnStart: true, turnInterrupt: true },
    });
    expect(betaStart).toMatchObject({
      host: "codex-test-host", harness: "codex", sessionId: betaSession, title: "Beta history", cwd: "/fake/beta",
      accountAlias: "Beta", codexControl: { source: "appServer", appServerOwned: true, turnStart: true, turnInterrupt: true },
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
      } },
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
    const { adapter } = startAdapter({
      identities: [{ accountAlias:"AckTerminal",codeHome:home }],
      hub,
      fixture: { profiles: { [basename(home)]: { threadId,title:"Terminal ack" } } },
    });
    await adapter.waitForReady(5_000);
    const session = sessionIdFor("AckTerminal", threadId), target = sessionKey("codex-test-host", session);
    await waitUntil(() => hub.waitSessions.has(session));
    hub.enqueue(session, { id:920,target,action:"turn/start",text:"first terminal receipt" });
    await waitUntil(() => hub.receiptAttempts.some(receipt => receipt.id === 920));
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

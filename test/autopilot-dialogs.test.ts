import { describe, expect, test } from "bun:test";
import type { QuestionInvocation, SessionDTO } from "../src/db.ts";
import type { AskQuestion } from "../src/normalize.ts";
import {
  autopilotDialogHookResponse, createAutopilotDialogs, dialogHoldBudgetMs, parseAutopilotDialogGate,
  type AskHookRegistration, type AutopilotDialogEnvironment, type AutopilotDialogGate, type AutopilotDialogs,
  type AutopilotDialogStore,
} from "../src/autopilot-dialogs.ts";
import type { AutopilotGoal } from "../src/autopilot-store.ts";
interface DialogFixtureState {
  activeGoal: AutopilotGoal | undefined;
  away: boolean;
  master: boolean;
  ownerPending: boolean;
  stopPhrases: string[];
  lastReplyAt: number | null;
  repliesLastHour: number;
}
interface DialogFixture {
  dialogs: AutopilotDialogs;
  state: DialogFixtureState;
  holds: unknown[];
  metrics: unknown[];
  request(overrides?: Partial<AskHookRegistration>): AskHookRegistration;
  sessionKey: string;
  now(): number;
  setNow(value: number): void;
  setSession(value: SessionDTO): void;
  setInvocation(value: QuestionInvocation): void;
  currentSession(): SessionDTO;
  currentInvocation(): QuestionInvocation;
}

const env: AutopilotDialogEnvironment = {
  DASH_DIALOGS: "1", DASH_AUTOPILOT: "1", DASH_REPLIES: "1",
  DASH_DIALOGS_E3_PASS: "1", DASH_DIALOGS_E4_PASS: "1", DASH_DIALOGS_E5_MAX_HOLD_MS: "600000",
};
const question: AskQuestion = {
  id: "q1", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], recommended: 0,
};
const questions = (): AskQuestion[] => structuredClone([question]);

function goal(sessionKey: string, delayMin: number | null = 0): AutopilotGoal {
  return {
    id: 7, sessionKey, goalVersionId: 3, goalText: "Use the chosen database", stopCondition: "goal is met",
    delayMin, status: "active", maxTurns: 20, turnsUsed: 0, expiresAt: 2_000_000,
    createdBy: "owner", createdAt: 1, updatedAt: 1, lastVerdict: null, lastVerdictAt: null,
    pausedBy: null, turnSeqAtResume: 5,
  };
}

function fixture(options: {
  gateEnv?: AutopilotDialogEnvironment;
  away?: boolean;
  master?: boolean;
  delayMin?: number | null;
  recommendation?: number | undefined;
} = {}): DialogFixture {
  let now = 1_000;
  const sessionKey = "host|claude|session";
  let session: SessionDTO = {
    key: sessionKey, host: "host", harness: "claude", sessionId: "session", displayName: "synthetic",
    project: "project", status: "needs_input", needsReason: "question", pendingQuestionId: "inv-1",
    backgroundPending: false, interactive: true, alive: true, createdAt: 0, lastActivity: now,
    unreadCount: 0, lastResponses: [], turnSeq: 5,
  };
  let invocation: QuestionInvocation = {
    id: "inv-1", sessionKey, toolUseId: "tool-1", questions: questions(), state: "pending",
    createdAt: now - 1, expiresAt: now + 1_000_000,
  };
  if (options.recommendation !== undefined) invocation.questions[0]!.recommended = options.recommendation;
  else if (options.recommendation === undefined && Object.hasOwn(options, "recommendation"))
    delete invocation.questions[0]!.recommended;
  const state: DialogFixtureState = {
    activeGoal: options.delayMin === undefined ? goal(sessionKey) : goal(sessionKey, options.delayMin),
    away: options.away ?? false,
    master: options.master ?? true,
    ownerPending: false,
    stopPhrases: [],
    lastReplyAt: null,
    repliesLastHour: 0,
  };
  const store = {
    goalForSession: (_key: string) => state.activeGoal,
    masterEnabled: () => state.master,
    away: () => state.away,
    customStopPhrases: () => state.stopPhrases,
    ownerReplyPending: (_key: string) => state.ownerPending,
    lastCommittedReplyAt: (_key: string, _at?: number) => state.lastReplyAt,
    committedRepliesLastHour: (_at?: number) => state.repliesLastHour,
  } as AutopilotDialogStore;
  const holds: unknown[] = [];
  const metrics: unknown[] = [];
  const dialogs = createAutopilotDialogs({
    store, now: () => now, gateEnv: options.gateEnv ?? env,
    getSession: key => key === sessionKey ? session : undefined,
    getInvocation: (id, key, toolUseId) => id === invocation.id && key === invocation.sessionKey && toolUseId === invocation.toolUseId
      ? invocation : undefined,
    postHold: plan => holds.push(plan), onMetric: sample => metrics.push(sample),
  });
  const request = (overrides: Partial<AskHookRegistration> = {}): AskHookRegistration => ({
    toolName: "AskUserQuestion", sessionKey, host: "host", toolUseId: "tool-1", invocationId: "inv-1",
    questions: structuredClone(invocation.questions), hookDeadlineMs: now + 600_000, ...overrides,
  });
  return {
    dialogs, state, holds, metrics, request, sessionKey,
    now: () => now,
    setNow: (value: number) => { now = value; },
    setSession: (value: SessionDTO) => { session = value; },
    setInvocation: (value: QuestionInvocation) => { invocation = value; },
    currentSession: () => session,
    currentInvocation: () => invocation,
  };
}

const enabledGate = (): AutopilotDialogGate => parseAutopilotDialogGate(env);

describe("autopilot Claude dialog gate", () => {
  test("fails closed for missing flags, attestations, and malformed bounds", () => {
    expect(parseAutopilotDialogGate({}).enabled).toBe(false);
    for (const key of ["DASH_DIALOGS", "DASH_AUTOPILOT", "DASH_REPLIES", "DASH_DIALOGS_E3_PASS", "DASH_DIALOGS_E4_PASS", "DASH_DIALOGS_E5_MAX_HOLD_MS"] as const) {
      const incomplete = { ...env, [key]: undefined };
      expect(parseAutopilotDialogGate(incomplete).enabled).toBe(false);
    }
    for (const value of ["0", "999", "600001", "1.5", "NaN", " 1000"]) {
      expect(parseAutopilotDialogGate({ ...env, DASH_DIALOGS_E5_MAX_HOLD_MS: value }).enabled).toBe(false);
    }
    for (const value of ["0", "11", "1.5", "bad"]) {
      expect(parseAutopilotDialogGate({ ...env, DASH_ASK_HOLD_MIN: value }).enabled).toBe(false);
    }
    expect(parseAutopilotDialogGate(env)).toEqual({ enabled: true, askHoldMin: 10, e5MaxHoldMs: 600_000 });
    expect(parseAutopilotDialogGate({ ...env, DASH_ASK_HOLD_MIN: "1" })).toEqual({
      enabled: true, askHoldMin: 1, e5MaxHoldMs: 600_000,
    });
  });

  test("caps holds by ask bound, E5 bound, and absolute server hook deadline", () => {
    const gate = enabledGate();
    expect(dialogHoldBudgetMs(gate, 1_000, 601_000)).toBe(600_000);
    expect(dialogHoldBudgetMs({ ...gate, askHoldMin: 1 }, 1_000, 601_000)).toBe(60_000);
    expect(dialogHoldBudgetMs({ ...gate, e5MaxHoldMs: 30_000 }, 1_000, 601_000)).toBe(30_000);
    expect(dialogHoldBudgetMs(gate, 1_000, 31_000)).toBe(30_000);
    expect(dialogHoldBudgetMs(gate, 1_000, 1_000)).toBeUndefined();
    expect(dialogHoldBudgetMs(gate, 1_000, 611_000)).toBe(600_000);
    expect(dialogHoldBudgetMs(gate, 1_000, 611_001)).toBeUndefined();
  });

  test("closed startup gate always releases, including while away", () => {
    const f = fixture({ gateEnv: { ...env, DASH_DIALOGS_E4_PASS: undefined }, away: true });
    expect(f.dialogs.register(f.request())).toEqual({ action: "release", reason: "gate" });
    expect(f.holds).toHaveLength(0);
  });
});

describe("autopilot Claude dialog decisions", () => {
  test("away mode takes precedence without a goal, master switch, or recommendation", () => {
    const f = fixture({ away: true, master: false, delayMin: null, recommendation: undefined });
    f.state.activeGoal = undefined;
    const decision = f.dialogs.register(f.request());
    expect(decision).toMatchObject({ action: "hold", mode: "owner", invocationId: "inv-1", questionId: "inv-1" });
    expect(decision.action === "hold" ? decision.autopilot : undefined).toBeUndefined();
    expect(f.holds).toHaveLength(1);
    expect(f.dialogs.register(f.request())).toEqual({ action: "release", reason: "duplicate" });
    expect(f.holds).toHaveLength(1);
  });

  test("away holds delay-zero and over-cap candidates instead of auto-answering", () => {
    for (const delayMin of [0, 2]) {
      const f = fixture({
        away: true, delayMin,
        ...(delayMin === 2 ? { gateEnv: { ...env, DASH_ASK_HOLD_MIN: "1" } } : {}),
      });
      f.dialogs.register(f.request());
      expect(f.holds[0]).toMatchObject({ mode: "owner", invocationId: "inv-1" });
    }
  });

  test("delay zero answers only exact recommended option indices for every question", () => {
    const f = fixture();
    const extra: AskQuestion = {
      id: "q2", question: "Which cache?", options: [{ label: "Redis" }, { label: "Memory" }], recommended: 1,
    };
    const multiQuestions = [...questions(), extra];
    f.setInvocation({ ...f.currentInvocation(), questions: multiQuestions });
    const decision = f.dialogs.register(f.request({ questions: multiQuestions }));
    expect(decision).toMatchObject({ action: "answer", source: "autopilot", answers: {
      "Which database?": "Postgres", "Which cache?": "Memory",
    } });
    if (decision.action === "answer") expect(decision.answers).not.toHaveProperty("free_text");
    expect(f.dialogs.register(f.request())).toEqual({ action: "release", reason: "duplicate" });
  });

  test("missing or invalid recommendation on any question releases without an answer", () => {
    const invalid = fixture();
    invalid.setInvocation({ ...invalid.currentInvocation(), questions: [{ ...question, recommended: 8 }] });
    expect(invalid.dialogs.register(invalid.request())).toMatchObject({ action: "release", reason: "recommendation" });
    const missing = fixture({ recommendation: undefined });
    expect(missing.dialogs.register(missing.request())).toMatchObject({ action: "release", reason: "recommendation" });
    const second = { id: "q2", question: "Another choice?", options: [{ label: "Yes" }, { label: "No" }] };
    const multiQuestions = [question, second];
    missing.setInvocation({ ...missing.currentInvocation(), questions: multiQuestions });
    expect(missing.dialogs.register(missing.request({ questions: multiQuestions })))
      .toMatchObject({ action: "release", reason: "recommendation" });
  });

  test("stop-and-ask scans every structured text field and custom stop phrases", () => {
    for (const modified of [
      { ...question, question: "Should I git push --force?" },
      { ...question, header: "rm -rf check" },
      { ...question, options: [{ label: "Safe", description: "DROP TABLE users" }, question.options[1]! ] },
      { ...question, options: [{ label: "Safe", preview: "gh secret set TOKEN" }, question.options[1]! ] },
    ]) {
      const f = fixture();
      const payload = [modified];
      f.setInvocation({ ...f.currentInvocation(), questions: payload });
      expect(f.dialogs.register(f.request({ questions: payload }))).toMatchObject({ action: "release", reason: "stop_ask" });
    }
    const f = fixture();
    f.state.stopPhrases = ["owner-only phrase"];
    const payload = [{ ...question, question: "owner-only phrase?" }];
    f.setInvocation({ ...f.currentInvocation(), questions: payload });
    expect(f.dialogs.register(f.request({ questions: payload }))).toMatchObject({ action: "release", reason: "stop_ask" });
  });
  test("accepts bounded Unicode stop phrases by code point count", () => {
    const f = fixture();
    f.state.stopPhrases = ["界".repeat(80)];
    expect(f.dialogs.register(f.request()).action).toBe("answer");
  });

  test("reports only a live registered invocation to the session fallback", () => {
    const f = fixture({ away: true });
    const request = f.request();
    expect(f.dialogs.hasRegisteredInvocation(request.sessionKey,request.invocationId)).toBe(false);
    expect(f.dialogs.register(request).action).toBe("hold");
    expect(f.dialogs.hasRegisteredInvocation(request.sessionKey,request.invocationId)).toBe(true);
    expect(f.dialogs.hasRegisteredInvocation("other-session",request.invocationId)).toBe(false);
    f.setNow(request.hookDeadlineMs);
    expect(f.dialogs.hasRegisteredInvocation(request.sessionKey,request.invocationId)).toBe(false);
  });

  test("requires active goal, enabled switches, fresh state, and available owner/rate gates", () => {
    const cases = [
      (f: DialogFixture) => { f.state.activeGoal = undefined; },
      (f: DialogFixture) => { f.state.activeGoal!.status = "paused"; },
      (f: DialogFixture) => { f.state.activeGoal!.turnSeqAtResume = 6; },
      (f: DialogFixture) => { f.state.master = false; },
      (f: DialogFixture) => { f.state.ownerPending = true; },
      (f: DialogFixture) => { f.state.activeGoal!.turnsUsed = f.state.activeGoal!.maxTurns; },
      (f: DialogFixture) => { f.state.activeGoal!.expiresAt = f.now(); },
      (f: DialogFixture) => { f.state.activeGoal!.delayMin = null; },
      (f: DialogFixture) => { f.state.lastReplyAt = f.now() - 1; },
      (f: DialogFixture) => { f.state.repliesLastHour = 30; },
    ];
    for (const change of cases) {
      const f = fixture(); change(f);
      expect(f.dialogs.register(f.request()).action).toBe("release");
    }
  });

  test("releases replaced invocation, host, session, and turn identities", () => {
    const replacement = fixture();
    const originalRequest = replacement.request();
    replacement.setInvocation({
      ...replacement.currentInvocation(), questions: [{ ...question, question: "changed payload?" }],
    });
    expect(replacement.dialogs.register(originalRequest)).toMatchObject({ action: "release", reason: "stale" });

    const wrongHost = fixture();
    expect(wrongHost.dialogs.register(wrongHost.request({ host: "other" })))
      .toMatchObject({ action: "release", reason: "stale" });

    const movedSession = fixture();
    movedSession.setSession({ ...movedSession.currentSession(), key: "other|claude|session" });
    expect(movedSession.dialogs.register(movedSession.request())).toMatchObject({ action: "release", reason: "stale" });

    const changedTurn = fixture({ delayMin: 1 });
    const request = changedTurn.request();
    const delayed = changedTurn.dialogs.register(request);
    expect(delayed.action).toBe("hold");
    changedTurn.setSession({ ...changedTurn.currentSession(), turnSeq: 6 });
    expect(changedTurn.dialogs.resolveDelayedAnswer(request)).toMatchObject({ action: "release", reason: "stale" });
  });

  test("holds only when positive delay fits; rechecks policy before answering at due time", () => {
    const f = fixture({ delayMin: 1 });
    const request = f.request();
    const held = f.dialogs.register(request);
    expect(held).toMatchObject({ action: "hold", mode: "autopilot_delay", answerAt: 61_000 });
    if (held.action !== "hold") throw new Error("Expected delayed hold");
    f.setNow(held.answerAt! - 1);
    expect(f.dialogs.resolveDelayedAnswer(request)).toMatchObject({ action: "hold", mode: "autopilot_delay" });
    f.setNow(held.answerAt!);
    expect(f.dialogs.resolveDelayedAnswer(request)).toMatchObject({ action: "answer", source: "autopilot" });
    expect(f.dialogs.resolveDelayedAnswer(request)).toMatchObject({ action: "release", reason: "stale" });

    const capped = fixture({ delayMin: 2, gateEnv: { ...env, DASH_ASK_HOLD_MIN: "1" } });
    expect(capped.dialogs.register(capped.request())).toMatchObject({ action: "release", reason: "delay_cap" });
  });

  test("releases delayed answers after goal text or stop condition edits", () => {
    const edits: Array<(current: AutopilotGoal) => Partial<AutopilotGoal>> = [
      current => ({
        goalVersionId: current.goalVersionId + 1,
        goalText: "Owner changed the goal during the delay",
        policyRevision: (current.policyRevision ?? 0) + 1,
      }),
      current => ({
        stopCondition: "The owner changed the stop condition",
        policyRevision: (current.policyRevision ?? 0) + 1,
      }),
    ];
    for (const edit of edits) {
      const f = fixture({ delayMin: 1 });
      const request = f.request();
      const held = f.dialogs.register(request);
      expect(held).toMatchObject({ action: "hold", mode: "autopilot_delay" });
      if (held.action !== "hold") throw new Error("Expected delayed hold");
      f.state.activeGoal = { ...f.state.activeGoal!, ...edit(f.state.activeGoal!) };
      f.setNow(held.answerAt!);
      expect(f.dialogs.resolveDelayedAnswer(request)).toMatchObject({ action: "release", reason: "stale" });
    }
  });

  test("away transition cancels the delayed answer and produces owner hold", () => {
    const f = fixture({ delayMin: 1 });
    const request = f.request();
    expect(f.dialogs.register(request).action).toBe("hold");
    f.state.away = true;
    expect(f.dialogs.resolveDelayedAnswer(request)).toMatchObject({ action: "hold", mode: "owner" });
    expect(f.dialogs.resolveDelayedAnswer(request)).toMatchObject({ action: "release", reason: "stale" });
  });

  test("owner pending answer and terminal cancellation prevent a delayed auto-answer", () => {
    const pendingOwner = fixture({ delayMin: 1 });
    const pendingRequest = pendingOwner.request();
    expect(pendingOwner.dialogs.register(pendingRequest).action).toBe("hold");
    pendingOwner.state.ownerPending = true;
    expect(pendingOwner.dialogs.resolveDelayedAnswer(pendingRequest))
      .toMatchObject({ action: "release", reason: "owner_pending" });
    expect(pendingOwner.dialogs.resolveDelayedAnswer(pendingRequest))
      .toMatchObject({ action: "release", reason: "stale" });

    const released = fixture({ delayMin: 1 });
    const releasedRequest = released.request();
    released.dialogs.register(releasedRequest);
    expect(released.dialogs.cancelDelayedAnswer(releasedRequest, "terminal_released", 20)).toBe(true);
    expect(released.dialogs.resolveDelayedAnswer(releasedRequest)).toMatchObject({ action: "release", reason: "stale" });
    released.dialogs.observeOutcome("owner_answered", 15);
    expect(released.dialogs.metrics().outcomes).toMatchObject({ terminal_released: 1, owner_answered: 1 });
  });

  test("rejects expired hooks, expired invocations, and malformed identities", () => {
    const expiredHook = fixture();
    expect(expiredHook.dialogs.register(expiredHook.request({ hookDeadlineMs: expiredHook.now() })))
      .toMatchObject({ action: "release", reason: "deadline" });
    expect(expiredHook.dialogs.register(expiredHook.request({ toolName: "PermissionRequest" })))
      .toMatchObject({ action: "release", reason: "invalid_request" });

    const wrongInvocation = fixture();
    expect(wrongInvocation.dialogs.register(wrongInvocation.request({ toolUseId: "tool-2" })))
      .toMatchObject({ action: "release", reason: "stale" });

    const expiredInvocation = fixture();
    expiredInvocation.setNow(1_001_000);
    expect(expiredInvocation.dialogs.register(expiredInvocation.request()))
      .toMatchObject({ action: "release", reason: "expired" });

    const omp = fixture();
    omp.setSession({ ...omp.currentSession(), harness: "omp" });
    expect(omp.dialogs.register(omp.request())).toMatchObject({ action: "release", reason: "stale" });
  });
});

describe("autopilot Claude dialog outputs and measurements", () => {
  test("serializes only the helper wire schema and never emits approval actions", () => {
    expect(autopilotDialogHookResponse({ action: "release", reason: "gate" })).toEqual({ action: "release" });
    expect(autopilotDialogHookResponse({
      action: "hold", mode: "owner", invocationId: "inv-1", questionId: "inv-1", expiresAt: 2_000,
    })).toEqual({ action: "hold", invocationId: "inv-1", questionId: "inv-1", expiresAt: 2_000 });
    expect(autopilotDialogHookResponse({
      action: "hold", mode: "autopilot_delay", invocationId: "inv-1", questionId: "inv-1",
      expiresAt: 2_000, answerAt: 1_500, autopilot: { goal_id: 7, expires_at: 3_000, remaining_ttl_ms: 1_000 },
    })).toEqual({ action: "hold", invocationId: "inv-1", questionId: "inv-1", expiresAt: 2_000,
      answerAt: 1_500, autopilot: { goal_id: 7, expires_at: 3_000, remaining_ttl_ms: 1_000 } });
    expect(autopilotDialogHookResponse({
      action: "answer", source: "autopilot", invocationId: "inv-1", answers: { "Which database?": "Postgres" },
      autopilot: { goal_id: 7, expires_at: 2_000_000, remaining_ttl_ms: 1_999_000 },
    })).toMatchObject({ action: "answer", source: "autopilot" });
    expect(autopilotDialogHookResponse({ action: "release", reason: "gate" })).not.toHaveProperty("approval");
  });

  test("exposes bounded text-free counters and metric hooks", () => {
    const f = fixture();
    f.dialogs.register(f.request());
    expect(f.dialogs.metrics()).toMatchObject({ attempts: 1, outcomes: { answered: 1 }, elapsedMs: { samples: 1 } });
    expect(f.metrics).toEqual([{ outcome: "answered", elapsedMs: expect.any(Number) }]);
    expect(JSON.stringify(f.dialogs.metrics())).not.toContain("Which database?");
    expect(JSON.stringify(f.metrics)).not.toContain("Postgres");
  });
});

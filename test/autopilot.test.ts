import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { prepareAudit } from "../src/audit.ts";
import { DashDB, type SessionDTO } from "../src/db.ts";
import { AUTOPILOT_MAX_TTL_MS, AUTOPILOT_RETENTION_MS, AutopilotStore } from "../src/autopilot-store.ts";
import { AUTOPILOT_VERDICT_SCHEMA, type AutopilotVerdict } from "../src/autopilot-policy.ts";
import { autopilotTemplateText, createAutopilot, type AutopilotController, type AutopilotTimerHandle, type AutopilotTimers, type CreateAutopilotOptions } from "../src/autopilot.ts";
import { JudgeError, type Judge, type JudgeOptions } from "../src/judge.ts";
import { createReplies } from "../src/replies.ts";

const ENV_KEYS = ["DASH_AUTOPILOT", "DASH_REPLIES", "DASH_AUTOPILOT_GRACE_S", "DASH_AUTOPILOT_CONCURRENCY"] as const;
const previousEnv = new Map<string, string | undefined>();
const fixtures = new Set<{ close(): void }>();

beforeEach(() => {
  previousEnv.clear();
  for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
  process.env.DASH_AUTOPILOT = "1";
  process.env.DASH_REPLIES = "1";
  process.env.DASH_AUTOPILOT_GRACE_S = "0";
  process.env.DASH_AUTOPILOT_CONCURRENCY = "2";
});

afterEach(() => {
  for (const fixture of fixtures) fixture.close();
  fixtures.clear();
  for (const key of ENV_KEYS) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

class ManualTimers implements AutopilotTimers {
  private nextId = 0;
  private readonly jobs = new Map<number, { dueAt: number; callback: () => void }>();
  constructor(private readonly clock: { now: number }) {}

  setTimeout(callback: () => void, delayMs: number): AutopilotTimerHandle {
    const id = ++this.nextId;
    this.jobs.set(id, { dueAt: this.clock.now + Math.max(0, delayMs), callback });
    return id;
  }
  clearTimeout(handle: AutopilotTimerHandle): void {
    if (typeof handle === "number") this.jobs.delete(handle);
  }

  async advanceBy(ms: number): Promise<void> {
    this.clock.now += ms;
    for (;;) {
      const due = [...this.jobs.entries()].filter(([, job]) => job.dueAt <= this.clock.now)
        .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0])[0];
      if (!due) return;
      this.jobs.delete(due[0]);
      due[1].callback();
      await settle();
    }
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

type JudgeCall = { prompt: string; schema: object; options?: JudgeOptions };
function makeJudge(answer: (call: JudgeCall) => Promise<unknown> | unknown) {
  const calls: JudgeCall[] = [];
  const judge: Judge = {
    async judge<T>(prompt: string, schema: object, options?: JudgeOptions): Promise<T> {
      const call = { prompt, schema, options };
      calls.push(call);
      return await answer(call) as T;
    },
    close() {},
  };
  return { judge, calls };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

const continueVerdict: AutopilotVerdict = {
  action: "continue", rationale: "routine reversible next step", confidence: 0.94, risk_flags: [],
};

function makeFixture() {
  const clock = { now: Date.now() };
  const db = new DashDB(":memory:", { decisionsEnabled: true });
  let store = new AutopilotStore(db);
  store.setMasterEnabled(true, clock.now);
  const timers = new ManualTimers(clock);
  const host = "synthetic-host";
  const controllers: AutopilotController[] = [];
  const event = (sessionId: string, kind: "session_start" | "prompt" | "question" | "response" | "error" | "session_end", text?: string): SessionDTO =>
    db.applyEvent({ host, harness: "claude", sessionId, kind, ts: clock.now++, interactive: true, ...(text === undefined ? {} : { text }) });
  const addSession = (sessionId: string, options: { goalText?: string; delayMin?: number | null; respond?: boolean; responseText?: string } = {}) => {
    const started = event(sessionId, "session_start");
    const key = started.key;
    const goal = store.createGoal({
      sessionKey: key,
      goalText: options.goalText ?? `Complete ${sessionId}`,
      stopCondition: "the owner-authored success condition is met",
      delayMin: options.delayMin === undefined ? 0 : options.delayMin,
      expiresAt: clock.now + 8 * 60 * 60_000,
    }, clock.now);
    const response = options.respond === false ? undefined : db.applyEvent({
      host, harness: "claude", sessionId, kind: "response", ts: clock.now++, interactive: true,
      text: options.responseText ?? `Synthetic output for ${sessionId}; private marker ${sessionId}-ONLY-IN-RESPONSE`,
    }).lastResponses.at(-1);
    return { key, goal, session: db.getSession(key)!, response };
  };
  const replies = createReplies({
    db,
    now: () => clock.now,
    setTimer: () => () => {},
    autopilotAllowed: (key, goalId) => {
      const goal = store.getGoal(goalId);
      return !!goal && goal.sessionKey === key && goal.status === "active" && store.masterEnabled();
    },
    autopilotDelivery: reply => {
      const goalId = Number(/^autopilot:goal:([1-9]\d*)$/.exec(reply.actor ?? "")?.[1]);
      const goal = Number.isSafeInteger(goalId) ? store.getGoal(goalId) : undefined;
      if (!goal || goal.status !== "active" || goal.sessionKey !== reply.sessionKey) return null;
      return { goal_id: goal.id, expires_at: goal.expiresAt, remaining_ttl_ms: Math.max(0, goal.expiresAt - clock.now) };
    },
  });
  const makeController = (judge: Judge, callbacks: Pick<CreateAutopilotOptions, "onEscalation" | "onSuggestion" | "onChanged"> = {}) => {
    const controller = createAutopilot({ db, store, replies, judge, now: () => clock.now, timers, ...callbacks });
    controllers.push(controller);
    return controller;
  };
  const rehydrateStore = () => { store = new AutopilotStore(db); return store; };
  let closed = false;
  const fixture = {
    db, clock, timers, replies, get store() { return store; }, event, addSession, makeController, rehydrateStore,
    close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.close();
      replies.close();
      db.close();
    },
  };
  fixtures.add(fixture);
  return fixture;
}

describe("autopilot scheduler", () => {
  test("inserts shell-like owner goal text literally in every fixed template", () => {
    const goalText = "Use $& and $$ plus $` and $' without expansion";
    for (const template of ["T_CONTINUE", "T_CHOOSE_SINGLE", "T_CHOOSE_MULTI"] as const) {
      const rendered = autopilotTemplateText(template, goalText);
      expect(rendered).toContain(goalText);
      expect(rendered).not.toContain("{goal}");
    }
  });

  test("waits through grace, uses the fixed schema/prompt, and never echoes response text", async () => {
    process.env.DASH_AUTOPILOT_GRACE_S = "2";
    const f = makeFixture();
    const seeded = f.addSession("grace", { goalText: "Prepare a bounded synthetic summary", delayMin: 0 });
    const judged = makeJudge(() => continueVerdict);
    const controller = f.makeController(judged.judge);
    await f.timers.advanceBy(1_999);
    expect(judged.calls).toHaveLength(0);
    await f.timers.advanceBy(1);
    expect(judged.calls).toHaveLength(1);
    expect(judged.calls[0]!.schema).toBe(AUTOPILOT_VERDICT_SCHEMA);
    expect(judged.calls[0]!.prompt).toContain("Prepare a bounded synthetic summary");
    expect(judged.calls[0]!.prompt).toContain("owner-authored success condition");
    expect(judged.calls[0]!.prompt).toContain("private marker grace-ONLY-IN-RESPONSE");
    expect(judged.calls[0]!.prompt).toContain("<autopilot_untrusted_data nonce=");
    expect(judged.calls[0]!.options).toMatchObject({ timeoutMs: 180_000 });
    const decisions = f.store.listDecisions({ sessionKey: seeded.key });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ status: "sent", executionMethod: "immediate", templateType: "T_CONTINUE" });
    const queued = f.db.sqlite.query("SELECT text,source,actor FROM replies WHERE session_key=?").all(seeded.key) as Array<{ text: string; source: string; actor: string }>;
    expect(queued).toEqual([{
      text: "[dash autopilot, not the owner] Goal: Prepare a bounded synthetic summary. Continue toward it with the next step you recommended. If a decision needs the owner (stop-and-ask list, real money, a genuine near-tie), ask instead of proceeding.",
      source: "autopilot", actor: `autopilot:goal:${seeded.goal.id}`,
    }]);
    const metrics = controller.metrics();
    expect(metrics.turnsByTemplate).toEqual({ T_CONTINUE: 0, T_CHOOSE_SINGLE: 0, T_CHOOSE_MULTI: 0 });
    expect(metrics.judge).toMatchObject({ calls: 1, failures: 0, fallbackCount: 0 });
    expect(metrics.judge.p50Ms).not.toBeNull();
    expect(metrics.judge.p95Ms).not.toBeNull();
    controller.close();
  });

  test("keeps the current response in the bounded judge history", async () => {
    const f = makeFixture();
    f.addSession("history-budget", { delayMin: 0 });
    f.event("history-budget","response","A".repeat(3_000));
    f.event("history-budget","response","B".repeat(3_000));
    f.event("history-budget","response","CURRENT_RESPONSE_MARKER");
    const judged = makeJudge(() => continueVerdict);
    f.makeController(judged.judge);
    await f.timers.advanceBy(0);
    expect(judged.calls).toHaveLength(1);
    expect(judged.calls[0]!.prompt).toContain("CURRENT_RESPONSE_MARKER");
  });

  test("reconciles a synchronously handed-off Claude reply as sent", async () => {
    const f = makeFixture();
    const seeded = f.addSession("sync-delivery", { delayMin: 0 });
    const judged = makeJudge(() => continueVerdict);
    let controller: AutopilotController;
    const submit = f.replies.submit.bind(f.replies);
    f.replies.submit = input => {
      const result = submit(input);
      if ("ok" in result && input.source === "autopilot") {
        expect(f.db.takeQueuedForClaude(seeded.key,result.replyId,seeded.session.turnSeq,f.clock.now).kind).toBe("taken");
        const moved = f.event("sync-delivery","prompt","Synthetic synchronous handoff");
        controller.onSessionChange(moved,"prompt");
      }
      return result;
    };
    controller = f.makeController(judged.judge);
    controller.wake(seeded.key);
    await f.timers.advanceBy(0);
    const decision = f.store.listDecisions({sessionKey:seeded.key})[0]!;
    const reply = f.db.getReply(decision.replyId!);
    expect(decision).toMatchObject({status:"sent",replyId:expect.any(Number)});
    expect(reply?.committedAt).not.toBeNull();
  });

  test("owner reply wins a judge race and leaves no autopilot reply queued", async () => {
    const f = makeFixture();
    const seeded = f.addSession("owner-race", { delayMin: 0 });
    const answer = deferred<unknown>();
    const judged = makeJudge(() => answer.promise);
    const controller = f.makeController(judged.judge);
    await f.timers.advanceBy(0);
    expect(judged.calls).toHaveLength(1);
    const owner = f.replies.submit({ key: seeded.key, text: "Owner response", source: "web", actor: "web:loopback",
      answersTurn: seeded.session.turnSeq, expectedTurn: seeded.session.turnSeq });
    expect(owner).toMatchObject({ ok: true });
    expect(judged.calls[0]!.options?.stillWanted?.()).toBe(false);
    answer.resolve(continueVerdict);
    await settle();
    expect(f.store.listDecisions({ sessionKey: seeded.key })).toMatchObject([{ status: "cancelled_owner", gateRule: "owner_reply" }]);
    expect(f.db.sqlite.query("SELECT id FROM replies WHERE session_key=? AND source='autopilot'").all(seeded.key)).toEqual([]);
    controller.close();
  });
  test("owner reply cancels a queued autopilot decision before it counts as sent", async () => {
    const f = makeFixture();
    const seeded = f.addSession("owner-queued", { delayMin: 0 });
    const judged = makeJudge(() => continueVerdict);
    const controller = f.makeController(judged.judge);
    await f.timers.advanceBy(0);
    const decision = f.store.listDecisions({ sessionKey: seeded.key })[0]!;
    expect(decision.status).toBe("sent");
    const autopilotReply = f.db.sqlite.query(`SELECT id,state,committed_at FROM replies
      WHERE session_key=? AND source='autopilot'`).get(seeded.key) as { id: number; state: string; committed_at: number | null } | null;
    expect(autopilotReply).toMatchObject({ state: "queued", committed_at: null });
    const owner = f.replies.submit({ key: seeded.key, text: "Owner response", source: "web", actor: "web:loopback",
      answersTurn: seeded.session.turnSeq, expectedTurn: seeded.session.turnSeq });
    expect(owner).toMatchObject({ ok: true });
    controller.onSessionChange(f.db.getSession(seeded.key)!, "owner_reply");
    expect(f.store.getDecision(decision.id)).toMatchObject({ status: "cancelled_owner", gateRule: "owner_reply" });
    expect(f.db.sqlite.query("SELECT state FROM replies WHERE id=?").get(autopilotReply!.id)).toEqual({ state: "cancelled" });
    controller.close();
  });
  test("records a stale run against its original goal version after an owner edit", async () => {
    const f = makeFixture();
    const seeded = f.addSession("goal-edit-race", { delayMin: 0 });
    const answer = deferred<unknown>();
    const judged = makeJudge(() => answer.promise);
    const controller = f.makeController(judged.judge);
    await f.timers.advanceBy(0);
    const originalVersionId = seeded.goal.goalVersionId;
    f.store.updateGoal(seeded.goal.id, { goalText: "Owner changed the goal during judging" }, f.clock.now);
    expect(judged.calls[0]!.options?.stillWanted?.()).toBe(false);
    answer.resolve(continueVerdict);
    await settle();
    expect(f.store.listDecisions({ sessionKey: seeded.key })).toMatchObject([
      { status: "stale", gateRule: "stale", goalVersionId: originalVersionId },
    ]);
    expect(f.db.sqlite.query("SELECT id FROM replies WHERE session_key=? AND source='autopilot'").all(seeded.key)).toEqual([]);
    controller.close();
  });

  test("stales a persisted delay immediately after the owner edits a goal policy field", async () => {
    const f = makeFixture();
    const seeded = f.addSession("pending-goal-policy-edit", { delayMin: 1 });
    const judged = makeJudge(() => continueVerdict);
    const controller = f.makeController(judged.judge);
    await f.timers.advanceBy(0);
    const pending = f.store.currentPendingAction(seeded.key)!;
    f.store.updateGoal(seeded.goal.id, { stopCondition: "The owner explicitly confirms completion" }, f.clock.now);
    expect(f.store.getGoal(seeded.goal.id)?.policyRevision).toBe(1);
    controller.refreshPending(seeded.key);
    expect(f.store.getDecision(pending.id)).toMatchObject({ status: "stale", gateRule: "goal_policy_changed" });
    await f.timers.advanceBy(60_000);
    expect(judged.calls).toHaveLength(1);
    expect(f.db.sqlite.query("SELECT id FROM replies WHERE session_key=? AND source='autopilot'").all(seeded.key)).toEqual([]);
    controller.close();
  });

  test("stales an old delayed action and wakes the new turn", async () => {
    const f = makeFixture();
    const seeded = f.addSession("pending-new-turn", { delayMin: 1 });
    const judged = makeJudge(() => continueVerdict);
    const controller = f.makeController(judged.judge);
    await f.timers.advanceBy(0);
    const oldAction = f.store.currentPendingAction(seeded.key)!;
    const nextTurn = f.event("pending-new-turn", "response", "Synthetic next response");
    controller.onSessionChange(nextTurn, "response");
    await f.timers.advanceBy(0);
    expect(f.store.getDecision(oldAction.id)).toMatchObject({ status: "stale", gateRule: "turn_changed" });
    expect(judged.calls).toHaveLength(2);
    expect(f.store.listDecisions({ sessionKey: seeded.key })).toMatchObject([
      { turnSeq: nextTurn.turnSeq, status: "pending" },
      { turnSeq: seeded.session.turnSeq, status: "stale" },
    ]);
    controller.close();
  });


  test("serializes FIFO judge work at the configured concurrency limit", async () => {
    process.env.DASH_AUTOPILOT_CONCURRENCY = "1";
    const f = makeFixture();
    f.addSession("fifo-a", { delayMin: 0 });
    f.addSession("fifo-b", { delayMin: 0 });
    const first = deferred<unknown>(), second = deferred<unknown>();
    const judged = makeJudge(() => judged.calls.length === 1 ? first.promise : second.promise);
    f.makeController(judged.judge);
    await f.timers.advanceBy(0);
    expect(judged.calls).toHaveLength(1);
    first.resolve(continueVerdict);
    await settle();
    expect(judged.calls).toHaveLength(2);
    second.resolve(continueVerdict);
    await settle();
    expect(f.db.sqlite.query("SELECT COUNT(*) AS n FROM replies WHERE source='autopilot'").get()).toEqual({ n: 2 });
  });
  test("reports bounded judge failure/fallback and aggregate-only metrics", async () => {
    const f = makeFixture();
    f.addSession("metrics", { delayMin: 0, responseText: "Private synthetic metric response" });
    const judged = makeJudge(call => {
      call.options?.onFallback?.();
      throw new JudgeError("timeout");
    });
    const controller = f.makeController(judged.judge);
    await f.timers.advanceBy(0);
    const stats = controller.metrics();
    expect(stats.judge).toMatchObject({ calls: 1, failures: 1, fallbackCount: 1 });
    expect(stats.escalationsByReason).toEqual({ judge: 1 });
    expect(JSON.stringify(stats)).not.toContain("Private synthetic metric response");
    controller.close();
  });
  test("stop-and-ask policy escalates a continue hypothesis without queuing a reply", async () => {
    const f = makeFixture();
    f.store.setCustomStopPhrases(["owner-only-token"]);
    const seeded = f.addSession("stop-rule", { delayMin: 0, responseText: "Proceed only after owner-only-token is resolved." });
    const escalations: string[] = [];
    const judged = makeJudge(() => continueVerdict);
    f.makeController(judged.judge, { onEscalation: notice => escalations.push(notice.reason) });
    await f.timers.advanceBy(0);
    expect(f.store.getGoal(seeded.goal.id)?.status).toBe("escalated");
    expect(f.store.listDecisions({ sessionKey: seeded.key })).toMatchObject([{ status: "escalated", gateRule: "stop_ask:custom_phrase" }]);
    expect(escalations).toEqual(["stop_ask:custom_phrase"]);
    expect(f.db.sqlite.query("SELECT id FROM replies WHERE source='autopilot'").all()).toEqual([]);
  });

  test("done closes the goal, persists the outcome, and notifies through the change callback", async () => {
    const f = makeFixture();
    const seeded = f.addSession("done", { delayMin: 0 });
    const changed: Array<{ status: string | undefined }> = [];
    const done: AutopilotVerdict = { action: "done", rationale: "Owner-authored stop condition met", confidence: 0.92, risk_flags: [] };
    const judged = makeJudge(() => done);
    f.makeController(judged.judge, { onChanged: (_key, decision) => changed.push({ status: decision?.status }) });
    await f.timers.advanceBy(0);
    expect(f.store.getGoal(seeded.goal.id)?.status).toBe("done");
    expect(f.store.listDecisions({ sessionKey: seeded.key })).toMatchObject([{ status: "dropped", gateRule: "done" }]);
    expect(changed).toEqual([{ status: "dropped" }]);
    expect(f.db.sqlite.query("SELECT id FROM replies WHERE source='autopilot'").all()).toEqual([]);
  });


  test("escalates a post-resume session error without calling the judge", async () => {
    const f = makeFixture();
    const seeded = f.addSession("error", { respond: false, delayMin: 0 });
    f.event("error", "prompt");
    const current = f.event("error", "error", "Synthetic failure after the goal started");
    const judged = makeJudge(() => continueVerdict);
    const escalations: Array<{ reason: string }> = [];
    f.makeController(judged.judge, { onEscalation: notice => escalations.push({ reason: notice.reason }) });
    await f.timers.advanceBy(0);
    expect(judged.calls).toHaveLength(0);
    expect(f.store.getGoal(seeded.goal.id)?.status).toBe("escalated");
    expect(f.store.listDecisions({ sessionKey: seeded.key })).toMatchObject([{ status: "escalated", gateRule: "session_error" }]);
    expect(escalations).toEqual([{ reason: "session_error" }]);
    expect(current.status).toBe("your_turn");
  });

  test("never runs a normal judge for needs_input and cancels timed actions on terminal dialog", async () => {
    const f = makeFixture();
    const delayed = f.addSession("dialog-delay", { delayMin: 1 });
    const judged = makeJudge(() => continueVerdict);
    const controller = f.makeController(judged.judge);
    await f.timers.advanceBy(0);
    const pending = f.store.currentPendingAction(delayed.key)!;
    const question = f.event("dialog-delay", "question", "Synthetic native question");
    controller.onSessionChange(question, "question");
    expect(f.store.getDecision(pending.id)).toMatchObject({ status: "held", gateRule: "terminal_dialog" });
    await f.timers.advanceBy(60_000);
    expect(judged.calls).toHaveLength(1);
    expect(f.db.sqlite.query("SELECT id FROM replies WHERE source='autopilot'").all()).toEqual([]);
    controller.close();

    f.addSession("native-dialog", { respond: false });
    const nativeQuestion = f.event("native-dialog", "question", "Unheld native question");
    const freshJudge = makeJudge(() => continueVerdict);
    const nativeController = f.makeController(freshJudge.judge);
    nativeController.onSessionChange(nativeQuestion, "question");
    await f.timers.advanceBy(120_000);
    expect(freshJudge.calls).toHaveLength(0);
    expect(nativeQuestion.status).toBe("needs_input");
    const released = nativeController.dialogReleased(nativeQuestion);
    expect(released).toMatchObject({ ok: true, decision: { status: "escalated", gateRule: "dialog" } });
    expect(nativeController.dialogReleased(nativeQuestion)).toEqual(released);
    expect(f.store.listDecisions({ sessionKey: nativeQuestion.key })).toMatchObject([
      { status: "escalated", gateRule: "dialog" },
    ]);
    if (!released.ok) throw new Error("Expected native dialog release to escalate");
    expect(f.store.getGoal(released.decision.goalId)?.status).toBe("escalated");
    expect(nativeController.metrics().escalationsByReason).toEqual({ dialog: 1 });
    nativeController.close();
  });

  test("restores pending delays, supports veto and Hold, and honors Send now and Never", async () => {
    const f = makeFixture();
    const vetoed = f.addSession("restart-veto", { delayMin: 1 });
    const judged = makeJudge(() => continueVerdict);
    const beforeRestart = f.makeController(judged.judge);
    await f.timers.advanceBy(0);
    const pending = f.store.currentPendingAction(vetoed.key)!;
    expect(pending).toMatchObject({ status: "pending", executionMethod: "timer", deadlineAt: f.clock.now + 60_000 });
    beforeRestart.close();
    const hydrated = f.rehydrateStore();
    const afterRestart = f.makeController(judged.judge);
    expect(hydrated.getDecision(pending.id)?.status).toBe("pending");
    expect(afterRestart.veto(pending.id)).toMatchObject({ ok: true, decision: { status: "cancelled_owner", gateRule: "owner_veto" } });
    await f.timers.advanceBy(60_000);
    expect(f.db.sqlite.query("SELECT id FROM replies WHERE session_key=? AND source='autopilot'").all(vetoed.key)).toEqual([]);

    const held = f.addSession("restart-hold", { delayMin: 1 });
    afterRestart.onSessionChange(held.session, "response");
    await f.timers.advanceBy(0);
    const heldAction = f.store.currentPendingAction(held.key)!;
    expect(afterRestart.hold(heldAction.id)).toMatchObject({ ok: true, decision: { status: "held", gateRule: "owner_hold" } });
    expect(f.store.getGoal(held.goal.id)?.status).toBe("escalated");
    const timed = f.addSession("timeout", { delayMin: 1 });
    afterRestart.onSessionChange(timed.session, "response");
    await f.timers.advanceBy(0);
    await f.timers.advanceBy(60_000);
    expect(f.store.listDecisions({ sessionKey: timed.key })).toMatchObject([{ status: "sent", executionMethod: "immediate" }]);

    const sendNow = f.addSession("send-now", { delayMin: 1 });
    afterRestart.onSessionChange(sendNow.session, "response");
    await f.timers.advanceBy(0);
    const sendAction = f.store.currentPendingAction(sendNow.key)!;
    expect(afterRestart.sendNow(sendAction.id)).toMatchObject({ ok: true, decision: { status: "sent" } });
    const judgeCallsBeforeRepeat = judged.calls.length;
    afterRestart.wake(sendNow.key);
    await f.timers.advanceBy(0);
    expect(judged.calls).toHaveLength(judgeCallsBeforeRepeat);

    const never = f.addSession("never", { delayMin: null });
    const suggestions: Array<{ kind: string; templateText?: string }> = [];
    const neverJudge = makeJudge(() => continueVerdict);
    const neverController = f.makeController(neverJudge.judge, { onSuggestion: suggestion => suggestions.push(suggestion) });
    neverController.onSessionChange(never.session, "response");
    await f.timers.advanceBy(0);
    const neverAction = f.store.currentPendingAction(never.key)!;
    expect(neverAction).toMatchObject({ status: "pending", executionMethod: "suggestion", gateRule: "never" });
    expect(suggestions).toMatchObject([{ kind: "send_now", templateText: expect.stringContaining("Goal: Complete never") }]);
    expect(f.db.sqlite.query("SELECT id FROM replies WHERE session_key=? AND source='autopilot'").all(never.key)).toEqual([]);
    expect(neverController.sendNow(neverAction.id)).toMatchObject({ ok: true, decision: { status: "sent" } });

    expect(afterRestart.metrics().pendingOutcomes).toMatchObject({ pending: 0, deferred: 0, timeout: 1, sendNow: 2, veto: 1 });
    expect(afterRestart.metrics().escalationsByReason).toMatchObject({ owner_hold: 1 });
    const switchOff = f.addSession("switch-off-pending", { delayMin: 1 });
    afterRestart.onSessionChange(switchOff.session, "response");
    await f.timers.advanceBy(0);
    const switchDecision = f.store.currentPendingAction(switchOff.key)!;
    expect(switchDecision.status).toBe("pending");
    afterRestart.setMasterEnabled(false);
    expect(f.store.getDecision(switchDecision.id)?.status).toBe("cancelled_owner");
    afterRestart.setMasterEnabled(true);
    await f.timers.advanceBy(60_000);
    expect(f.db.sqlite.query("SELECT id FROM replies WHERE session_key=? AND source='autopilot'").all(switchOff.key)).toEqual([]);
    afterRestart.setMasterEnabled(false);
    const queuedAutopilot = f.db.sqlite.query("SELECT state FROM replies WHERE source='autopilot'").all() as Array<{ state: string }>;
    expect(queuedAutopilot.length).toBeGreaterThan(0);
    expect(queuedAutopilot.every(reply => reply.state === "cancelled")).toBe(true);
    expect(f.store.masterEnabled()).toBe(false);
    afterRestart.close();
    neverController.close();
  });

  test("a disabled environment flag suppresses wakes even with the stored master switch on", async () => {
    const f = makeFixture();
    f.addSession("env-off", { delayMin: 0 });
    process.env.DASH_REPLIES = "0";
    const judged = makeJudge(() => continueVerdict);
    f.makeController(judged.judge);
    await f.timers.advanceBy(120_000);
    expect(judged.calls).toHaveLength(0);
    expect(f.db.sqlite.query("SELECT id FROM autopilot_decisions").all()).toEqual([]);
  });

  test("store rejects noncanonical decision hashes and invalid escalation times", () => {
    const f = makeFixture();
    const { key, goal } = f.addSession("store-validation");
    const versionId = f.store.goalVersions(goal.id)[0]!.id;
    const decision = {
      sessionKey: key, project: "synthetic", goalId: goal.id, turnSeq: 0, responseId: null,
      responseHash: "a".repeat(40), decisionSetHash: "b".repeat(64), goalVersionId: versionId,
      templateType: "T_CONTINUE" as const, verdict: continueVerdict, delayMin: 0,
      decidedAt: f.clock.now, status: "dropped" as const, executionMethod: "none" as const,
    };
    expect(() => f.store.recordDecision({ ...decision, responseHash: "a".repeat(39) })).toThrow();
    expect(() => f.store.recordDecision({ ...decision, decisionSetHash: "b".repeat(63) })).toThrow();
    expect(() => f.store.escalateGoal(goal.id, "synthetic", -1)).toThrow();

    const stored = f.store.recordDecision({ ...decision, gateRule: "initial" });
    expect(f.store.transitionDecision(stored.id, ["dropped"], "held", f.clock.now, {
      gateRule: "temporary", replyId: 99, deadlineAt: f.clock.now + 100,
    })).toBe(true);
    expect(f.store.transitionDecision(stored.id, ["held"], "stale", f.clock.now, {
      gateRule: null, replyId: null, deadlineAt: null,
    })).toBe(true);
    expect(f.store.getDecision(stored.id)).toMatchObject({ gateRule: null, replyId: null, deadlineAt: null });
  });
  test("escalated goals remain visible and stoppable while suggestion claims are exclusive", () => {
    const f = makeFixture();
    const {key,goal} = f.addSession("escalated-controls");
    const versionId = f.store.goalVersions(goal.id)[0]!.id;
    const decision = f.store.recordDecision({
      sessionKey:key,project:"synthetic",goalId:goal.id,turnSeq:0,responseId:null,
      responseHash:"a".repeat(40),decisionSetHash:"b".repeat(64),goalVersionId:versionId,
      templateType:"T_CONTINUE",verdict:continueVerdict,delayMin:0,decidedAt:f.clock.now,
      status:"escalated",executionMethod:"none",gateRule:"owner_hold",
    });
    expect(f.store.escalateGoal(goal.id,"owner_hold",f.clock.now)).toBe(true);
    expect(f.store.goalForSession(key)?.status).toBe("escalated");
    expect(f.store.claimSuggestion(decision.id,f.clock.now)).toBe(true);
    expect(f.store.claimSuggestion(decision.id,f.clock.now)).toBe(false);
    expect(f.store.releaseSuggestionClaim(decision.id,f.clock.now)).toBe(true);
    expect(f.store.claimSuggestion(decision.id,f.clock.now+1)).toBe(true);
    expect(f.store.stopGoal(goal.id,f.clock.now+2)).toBe(true);
    expect(f.store.getGoal(goal.id)?.status).toBe("stopped");
  });
  test("filters decision pages by review state and composite project components", () => {
    const f = makeFixture();
    const {key,goal} = f.addSession("decision-filter");
    const versionId = f.store.goalVersions(goal.id)[0]!.id;
    const record = (project:string, decidedAt:number, reviewed = false) => {
      const decision = f.store.recordDecision({
        sessionKey:key,project,goalId:goal.id,turnSeq:0,responseId:null,
        responseHash:"a".repeat(40),decisionSetHash:"b".repeat(64),goalVersionId:versionId,
        templateType:null,verdict:continueVerdict,delayMin:0,decidedAt,status:"escalated",
        executionMethod:"none",gateRule:"review",
      });
      if (reviewed) f.store.markReviewed(decision.id,decidedAt+1);
      return decision;
    };
    record("squad",f.clock.now);
    record("rogue",f.clock.now+1,true);
    record("other",f.clock.now+2,true);
    expect(f.store.listDecisions({unreviewedOnly:true,limit:10}).map(decision => decision.project)).toEqual(["squad"]);
    expect(f.store.listDecisions({projects:["squad","rogue"],limit:10}).map(decision => decision.project).sort())
      .toEqual(["rogue","squad"]);
  });


  test("does not create goals for ended sessions", () => {
    const f = makeFixture();
    const session = f.event("goal-ended","session_start");
    f.event("goal-ended","session_end");
    expect(f.db.getSession(session.key)?.status).toBe("ended");
    expect(() => f.store.createGoal({ sessionKey:session.key,goalText:"No work after session end" },f.clock.now))
      .toThrow("session_ended");
  });

  test("prefers a resumed active goal over newer escalated history", () => {
    const f = makeFixture();
    const session = f.event("goal-history","session_start");
    const old = f.store.createGoal({ sessionKey:session.key,goalText:"Earlier goal",expiresAt:f.clock.now+60_000 },f.clock.now);
    expect(f.store.finishGoal(old.id,"escalated",f.clock.now)).toBe(true);
    const newer = f.store.createGoal({ sessionKey:session.key,goalText:"Newer goal",expiresAt:f.clock.now+60_000 },f.clock.now);
    expect(f.store.finishGoal(newer.id,"escalated",f.clock.now)).toBe(true);
    expect(f.store.resumeGoal(old.id,session.turnSeq,f.clock.now)).toBe(true);
    expect(f.store.goalForSession(session.key)?.id).toBe(old.id);
  });

  test("default decision retention batch clears more than 500 expired rows", () => {
    const f = makeFixture();
    const { key, goal } = f.addSession("retention-batch");
    const goalVersionId = f.store.goalVersions(goal.id)[0]!.id;
    const decidedAt = f.clock.now - AUTOPILOT_RETENTION_MS - 1;
    for (let turnSeq = 0; turnSeq < 501; turnSeq++) {
      f.store.recordDecision({
        sessionKey:key,project:"synthetic",goalId:goal.id,turnSeq,responseId:null,responseHash:null,decisionSetHash:null,
        goalVersionId,templateType:null,verdict:continueVerdict,delayMin:0,decidedAt,status:"dropped",executionMethod:"none",
      });
    }
    expect(f.store.pruneDecisions(f.clock.now)).toBe(501);
    expect(f.store.listDecisions({ sessionKey:key,limit:500 })).toHaveLength(0);
  });

  test("bounds goal expiry to the maximum fence-cache lifetime", () => {
    const f = makeFixture();
    const { key, goal } = f.addSession("goal-expiry-bound");
    const maximum = f.clock.now + AUTOPILOT_MAX_TTL_MS;
    expect(f.store.updateGoal(goal.id, { expiresAt: maximum }, f.clock.now).expiresAt).toBe(maximum);
    expect(() => f.store.updateGoal(goal.id, { expiresAt: maximum + 1 }, f.clock.now)).toThrow();
    expect(f.store.stopGoal(goal.id, f.clock.now)).toBe(true);
    expect(() => f.store.createGoal({
      sessionKey:key,goalText:"Bounded goal",expiresAt:maximum + 1,
    }, f.clock.now)).toThrow();
  });
  test("dialog actions count toward session cooldown and global reply rate", () => {
    const f = makeFixture();
    const first = f.addSession("dialog-budget-one");
    const second = f.addSession("dialog-budget-two");
    const dialogAt = f.clock.now;
    f.db.sqlite.query(`INSERT INTO autopilot_turn_events(event_key,goal_id,event_kind,created_at)
      VALUES(?,?,'dialog',?)`).run("question:synthetic-dialog",first.goal.id,dialogAt);
    expect(f.store.lastCommittedReplyAt(first.key,dialogAt)).toBe(dialogAt);
    expect(f.store.lastCommittedReplyAt(second.key,dialogAt)).toBeNull();
    expect(f.store.committedRepliesLastHour(dialogAt)).toBe(1);
    expect(f.store.resumeGoal(first.goal.id,0,dialogAt)).toBe(false);
    expect(f.store.escalateGoal(second.goal.id,"dialog",dialogAt)).toBe(true);
    expect(f.store.resumeGoal(second.goal.id,0,dialogAt)).toBe(true);
    expect(f.store.getGoal(second.goal.id)?.status).toBe("active");
  });

  test("resuming an escalated goal permits a fresh decision on the same turn", async () => {
    const f = makeFixture();
    const seeded = f.addSession("resume-same-turn", { delayMin: 0 });
    const versionId = f.store.goalVersions(seeded.goal.id)[0]!.id;
    f.store.recordDecision({
      sessionKey:seeded.key,project:"synthetic",goalId:seeded.goal.id,turnSeq:seeded.session.turnSeq,
      responseId:seeded.response!.id,responseHash:"a".repeat(40),decisionSetHash:"b".repeat(64),
      goalVersionId:versionId,templateType:"T_CONTINUE",verdict:continueVerdict,delayMin:0,
      decidedAt:f.clock.now,status:"escalated",executionMethod:"none",gateRule:"owner_hold",
    });
    expect(f.store.escalateGoal(seeded.goal.id,"owner_hold",f.clock.now)).toBe(true);
    expect(f.store.resumeGoal(seeded.goal.id,seeded.session.turnSeq,f.clock.now)).toBe(true);
    const judged = makeJudge(() => continueVerdict);
    const controller = f.makeController(judged.judge);
    controller.wake(seeded.key);
    await f.timers.advanceBy(0);
    expect(judged.calls).toHaveLength(1);
    expect(f.store.listDecisions({ sessionKey:seeded.key })).toHaveLength(2);
  });

  test("recent sent actions ignore deferred decisions", () => {
    const f = makeFixture();
    const { key, goal } = f.addSession("loop-breaker");
    const versionId = f.store.goalVersions(goal.id)[0]!.id;
    const makeDecision = (decidedAt: number, status: "sent" | "pending", responseHash: string) =>
      f.store.recordDecision({
        sessionKey:key,project:"synthetic",goalId:goal.id,turnSeq:0,responseId:null,responseHash,
        decisionSetHash:"b".repeat(64),goalVersionId:versionId,templateType:"T_CONTINUE",
        verdict:continueVerdict,delayMin:1,decidedAt,status,
        executionMethod:status === "sent" ? "immediate" : "timer",
      });
    makeDecision(f.clock.now, "sent", "a".repeat(40));
    makeDecision(f.clock.now + 1, "sent", "c".repeat(40));
    makeDecision(f.clock.now + 2, "pending", "d".repeat(40));
    expect(f.store.recentActions(key,2).map(action => action.responseHash)).toEqual(["c".repeat(40),"a".repeat(40)]);
  });
  test("acknowledges OMP autopilot commit after its turn-count trigger runs", () => {
    const f = makeFixture();
    const session = f.db.applyEvent({host:"synthetic-host",harness:"omp",sessionId:"omp-commit",
      kind:"session_start",ts:f.clock.now,interactive:true});
    const goal = f.store.createGoal({sessionKey:session.key,goalText:"Commit a bounded OMP turn",
      expiresAt:f.clock.now+60_000},f.clock.now);
    const turnSeq = f.db.getSession(session.key)!.turnSeq;
    f.db.sqlite.query("UPDATE sessions SET status='working' WHERE key=?").run(session.key);
    const actor = `autopilot:goal:${goal.id}`, text = "Synthetic fixed OMP reply";
    const audit = prepareAudit({ts:f.clock.now,sessionKey:session.key,source:"autopilot",actor,
      listener:"internal",text,goalId:goal.id});
    const reply = f.db.enqueueReply(session.key,text,"autopilot",actor,undefined,f.clock.now,60_000,audit);
    expect(f.db.leaseQueuedForOmp(session.key,reply.id,"synthetic-waiter",turnSeq,f.clock.now,true).kind).toBe("leased");
    expect(f.db.commitOmp(reply.id,"synthetic-waiter",f.clock.now+1)).toEqual({ok:true});
    expect(f.store.getGoal(goal.id)?.turnsUsed).toBe(1);
  });
  test("counts owner replies within five minutes of committed autopilot actions", () => {
    const f = makeFixture();
    const sent = (sessionId: string) => {
      const seeded = f.addSession(sessionId);
      const actor = `autopilot:goal:${seeded.goal.id}`;
      const text = "Synthetic fixed reply";
      const audit = prepareAudit({ts:f.clock.now,sessionKey:seeded.key,source:"autopilot",actor,
        listener:"internal",text,goalId:seeded.goal.id});
      const reply = f.db.enqueueReply(seeded.key,text,"autopilot",actor,seeded.session.turnSeq,f.clock.now,60_000,audit);
      f.db.sqlite.query("UPDATE sessions SET status='your_turn',needs_reason=NULL WHERE key=?").run(seeded.key);
      const sentAt = f.clock.now;
      const delivered = f.db.takeQueuedForClaude(seeded.key,reply.id,seeded.session.turnSeq,sentAt);
      expect(delivered.kind).toBe("taken");
      expect(f.store.getGoal(seeded.goal.id)?.turnsUsed).toBe(1);
      expect(f.store.lastCommittedReplyAt(seeded.key,sentAt)).toBe(sentAt);
      return { key:seeded.key,sentAt };
    };
    const first = sent("owner-override-near");
    const second = sent("owner-override-late");
    f.clock.now = first.sentAt + 300_000;
    expect(f.replies.submit({key:first.key,text:"Owner correction",source:"web",actor:"web:loopback"}).ok).toBe(true);
    f.clock.now = second.sentAt + 300_001;
    expect(f.replies.submit({key:second.key,text:"Late owner reply",source:"web",actor:"web:loopback"}).ok).toBe(true);
    process.env.DASH_AUTOPILOT = "0";
    const controller = f.makeController(makeJudge(() => continueVerdict).judge);
    expect(controller.metrics().ownerOverridesWithinFiveMinutes).toBe(1);
    controller.close();
  });
});

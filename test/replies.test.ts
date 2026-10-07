import { describe, expect, test } from "bun:test";
import { DashDB, type SessionDTO } from "../src/db.ts";
import type { NormalizedEvent } from "../src/normalize.ts";
import { createReplies } from "../src/replies.ts";
import { GO_REC_AUTH_TEXT } from "../src/actions.ts";

function fixture(harness: "claude" | "omp" = "claude", status: SessionDTO["status"] = "your_turn", needsReason?: string, ttlMs = 1000) {
  const db = new DashDB(":memory:");
  const clock = { now: 1_000_000 };
  const key = `synthetic-host|${harness}|synthetic-session`;
  const event = (kind: "session_start" | "prompt" | "question" | "permission" | "response" | "session_end") =>
    db.applyEvent({ host: "synthetic-host", harness, sessionId: "synthetic-session", kind, ts: clock.now++, interactive: true, text: "synthetic" });
  let dto = event("session_start");
  if (status !== "your_turn") dto = event(status === "working" ? "prompt" : status === "ended" ? "session_end" : "question");
  if (needsReason === "waiting" || needsReason === "permission") db.sqlite.query("UPDATE sessions SET needs_reason=? WHERE key=?").run(needsReason, key);
  dto = db.getSession(key)!;
  const outcomes: string[] = [];
  let sweep!: () => void;
  const sent: SessionDTO[] = [];
  const broker = createReplies({ db, now: () => clock.now, ttlMs,
    setTimer: fn => { sweep = fn; return () => {}; },
    onOutcome: (_reply, result) => outcomes.push(result), send: row => sent.push(row) });
  const close = () => { broker.close(); db.close(); };
  const submit = (text: string, source: "web" | "telegram" | "autopilot" = "telegram", answersTurn?: number) => {
    const result = broker.submit({ key, text, source, actor: source === "web" ? "web:loopback" :
      source === "telegram" ? "telegram:123" : "autopilot:goal:1", answersTurn });
    if (!("ok" in result)) throw new Error(result.reason);
    return db.getReply(result.replyId)!;
  };
  return { db, clock, dto, key, outcomes, sweep: () => sweep(), broker, event, sent, submit, close };
}
const waiter = "waiteraaaaaaaaaa";

describe("Claude question broker", () => {
  const firstId = Buffer.alloc(32, 1).toString("base64url");
  const secondId = Buffer.alloc(32, 2).toString("base64url");
  const questionEvent = (ts: number, toolUseId: string): NormalizedEvent => ({
    host: "synthetic-host", harness: "claude", sessionId: "synthetic-session",
    kind: "question", ts, interactive: true, toolUseId,
    questionData: [{ id: "Which route?", question: "Which route?",
      options: [{ label: "Keep (Recommended)" }, { label: "Replace" }] }],
  });

  test("wrong-identity cancellation cannot dislodge the active question waiter", async () => {
    const f = fixture();
    try {
      expect(f.broker.registerQuestion({ event: questionEvent(f.clock.now, "toolu_current"),
        id: firstId, toolUseId: "toolu_current", timeoutMs: 1000 })).toMatchObject({ ok: true });
      const waiting = f.broker.waitQuestion(f.key, firstId, "toolu_current", 1000);
      expect(f.broker.cancelQuestion(firstId, f.key, "toolu_wrong")).toBe(false);
      expect(f.broker.submitQuestion({ key: f.key, questionId: firstId, source: "web", actor: "web:loopback",
        answers: { "Which route?": { selectedOptions: [0] } } })).toEqual({ ok: true });
      expect(await waiting).toEqual({ status: 200, answers: { "Which route?": "Keep (Recommended)" } });
      expect(await f.broker.waitQuestion(f.key, firstId, "toolu_current", 1000)).toEqual({ status: 409 });
    } finally { f.close(); }
  });

  test("replacement invalidates old controls without losing a new custom Unicode answer", async () => {
    const f = fixture();
    try {
      expect(f.broker.registerQuestion({ event: questionEvent(f.clock.now, "toolu_old"),
        id: firstId, toolUseId: "toolu_old", timeoutMs: 1000 })).toMatchObject({ ok: true });
      const oldWait = f.broker.waitQuestion(f.key, firstId, "toolu_old", 1000);
      expect(f.broker.registerQuestion({ event: questionEvent(f.clock.now, "toolu_new"),
        id: secondId, toolUseId: "toolu_new", timeoutMs: 1000 })).toMatchObject({ ok: true });
      expect(await oldWait).toEqual({ status: 409 });
      expect(f.broker.submitQuestion({ key: f.key, questionId: firstId, source: "web", actor: "web:loopback",
        answers: { "Which route?": { selectedOptions: [0] } } })).toMatchObject({ refused: true, reason: "stale_question" });
      expect(f.broker.submitQuestion({ key: f.key, questionId: secondId, source: "web", actor: "web:loopback",
        answers: { "Which route?": { selectedOptions: [], customInput: "Route 雪 & café" } } })).toEqual({ ok: true });
      expect(await f.broker.waitQuestion(f.key, secondId, "toolu_new", 1000)).toEqual({
        status: 200, answers: { "Which route?": "Route 雪 & café" },
      });
    } finally { f.close(); }
  });

  test("expiry rejects the waiting client and prevents an answer from reviving the invocation", async () => {
    const f = fixture();
    try {
      expect(f.broker.registerQuestion({ event: questionEvent(f.clock.now, "toolu_expiring"),
        id: firstId, toolUseId: "toolu_expiring", timeoutMs: 1000 })).toMatchObject({ ok: true });
      const waiting = f.broker.waitQuestion(f.key, firstId, "toolu_expiring", 1000);
      f.clock.now += 1000;
      f.sweep();
      expect(await waiting).toEqual({ status: 409 });
      expect(f.broker.submitQuestion({ key: f.key, questionId: firstId, source: "web", actor: "web:loopback",
        answers: { "Which route?": { selectedOptions: [1] } } })).toMatchObject({ refused: true, reason: "stale_question" });
    } finally { f.close(); }
  });
  test("an answered invocation survives its same-tool duplicate until /question/wait consumes the original answer", async () => {
    const f = fixture();
    f.clock.now = Date.now();
    const toolUseId = "toolu_same_invocation";
    try {
      expect(f.broker.registerQuestion({ event: questionEvent(f.clock.now,toolUseId),
        id: firstId,toolUseId,timeoutMs:60_000 })).toMatchObject({ ok:true });
      expect(f.broker.submitQuestion({ key:f.key,questionId:firstId,source:"web",actor:"web:loopback",
        answers:{ "Which route?":{ selectedOptions:[0] } } })).toEqual({ ok:true });
      const answeredAt = f.db.questionInvocationsForSession(f.key)[0]?.answeredAt ?? 0;

      f.clock.now += 1;
      const duplicate = f.db.applyEvent(questionEvent(f.clock.now,toolUseId));
      expect(duplicate.status).toBe("working");
      expect(f.db.questionInvocationsForSession(f.key)[0]?.lastHookEventAt).toBeGreaterThan(answeredAt);
      f.broker.observe(duplicate);

      expect(f.db.getQuestionInvocation(firstId,f.key,toolUseId)).toMatchObject({ state:"answered" });
      expect(await f.broker.waitQuestion(f.key,firstId,toolUseId,1000)).toEqual({
        status:200,answers:{ "Which route?":"Keep (Recommended)" },
      });
      expect(f.db.getQuestionInvocation(firstId,f.key,toolUseId)).toMatchObject({ state:"consumed" });
      expect(f.db.getQuestionInvocation(firstId,f.key,toolUseId)?.answers).toBeUndefined();
    } finally { f.close(); }
  });

  test("wait rejects an answered invocation after an unobserved new prompt", async () => {
    const f = fixture();
    f.clock.now = Date.now();
    const toolUseId = "toolu_unobserved_prompt";
    try {
      expect(f.broker.registerQuestion({ event: questionEvent(f.clock.now,toolUseId),
        id:firstId,toolUseId,timeoutMs:60_000 })).toMatchObject({ ok:true });
      expect(f.broker.submitQuestion({ key:f.key,questionId:firstId,source:"web",actor:"web:loopback",
        answers:{ "Which route?":{ selectedOptions:[0] } } })).toEqual({ ok:true });

      f.clock.now += 1;
      const moved = f.db.applyEvent({ host:"synthetic-host",harness:"claude",sessionId:"synthetic-session",
        kind:"prompt",ts:f.clock.now,interactive:true,text:"synthetic next prompt" });
      expect(moved.status).toBe("working");
      expect(await f.broker.waitQuestion(f.key,firstId,toolUseId,1000)).toEqual({ status:409 });
      expect(f.db.getQuestionInvocation(firstId,f.key,toolUseId))
        .toMatchObject({ state:"cancelled",cancelReason:"session_moved" });
    } finally { f.close(); }
  });

  test.each([
    ["new prompt","prompt"],
    ["distinct tool question","distinct-question"],
    ["permission event","permission"],
    ["terminal response","response"],
    ["session end","session_end"],
    ["expiry","expiry"],
  ] as const)("%s cancels a previously answered invocation", async (_scenario,movement) => {
    const f = fixture();
    f.clock.now = Date.now();
    const toolUseId = "toolu_answered";
    try {
      expect(f.broker.registerQuestion({ event: questionEvent(f.clock.now,toolUseId),
        id: firstId,toolUseId,timeoutMs:1000 })).toMatchObject({ ok:true });
      expect(f.broker.submitQuestion({ key:f.key,questionId:firstId,source:"web",actor:"web:loopback",
        answers:{ "Which route?":{ selectedOptions:[1] } } })).toEqual({ ok:true });

      f.clock.now += movement === "expiry" ? 1000 : 1;
      const moved = movement === "distinct-question"
        ? f.db.applyEvent(questionEvent(f.clock.now,"toolu_distinct"))
        : movement === "expiry"
          ? f.db.applyEvent(questionEvent(f.clock.now,toolUseId))
          : f.db.applyEvent({ host:"synthetic-host",harness:"claude",sessionId:"synthetic-session",
            kind:movement,ts:f.clock.now,interactive:true,text:"synthetic movement" });
      f.broker.observe(moved);

      expect(f.db.getQuestionInvocation(firstId,f.key,toolUseId)).toMatchObject({
        state:"cancelled",
        cancelReason:movement === "session_end" ? "session_ended" : movement === "expiry" ? "expired" : "session_moved",
      });
      expect(await f.broker.waitQuestion(f.key,firstId,toolUseId,1000))
        .toEqual({ status:movement === "session_end" ? 410 : 409 });
    } finally { f.close(); }
  });
});

describe("reply broker", () => {
  test("validates every refusal without queueing and records attributable refusals once", () => {
    const badShapes = [
      [{ key: "bad", text: "hello", source: "web", actor: "web:loopback" }, "invalid_key"],
      [{ key: "synthetic-host|claude|synthetic-session", text: "hello", source: "other", actor: "web:loopback" }, "invalid_source"],
      [{ key: "synthetic-host|claude|synthetic-session", text: "hello", source: "web", actor: "wrong" }, "invalid_actor"],
      [{ key: "synthetic-host|claude|synthetic-session", text: 123, source: "web", actor: "web:loopback" }, "invalid_text"],
      [{ key: "synthetic-host|claude|synthetic-session", text: "\u0001 ", source: "web", actor: "web:loopback" }, "empty_text"],
      [{ key: "synthetic-host|claude|synthetic-session", text: "hello", source: "autopilot", actor: "autopilot:goal:1" }, "invalid_turn"],
    ] as const;
    const f = fixture();
    try {
      for (const [args, reason] of badShapes) {
        expect(f.broker.submit(args as any)).toEqual({ refused: true, reason });
        expect(f.db.replyCounts().queued).toBe(0);
      }
      expect(f.outcomes).toEqual([]);
      expect((f.db.sqlite.query("SELECT count(*) AS n FROM reply_audit").get() as any).n).toBe(0);
    } finally { f.close(); }
  });

  test("autopilot can never send the owner's Rec auth'd text", () => {
    const f = fixture();
    try {
      const autopilot = (text: string) => f.broker.submit({ key: f.key, text, source: "autopilot", actor: "autopilot:goal:1", answersTurn: f.dto.turnSeq });
      const [, second] = GO_REC_AUTH_TEXT.split(/(?<=\.) /);
      for (const text of [GO_REC_AUTH_TEXT, `  ${GO_REC_AUTH_TEXT}\n`, `prefix ${GO_REC_AUTH_TEXT.replace(/ /g, "\n ")}`,
        GO_REC_AUTH_TEXT.toLowerCase(), GO_REC_AUTH_TEXT.replace(/o/g, "o\u200b"), `Go on. ${second}`, second!.replace(/\.$/, "")])
        expect(autopilot(text)).toEqual({ refused: true, reason: "invalid_source" });
      expect(f.db.replyCounts().queued).toBe(0);
      expect(f.submit(GO_REC_AUTH_TEXT, "telegram", f.dto.turnSeq)).toMatchObject({ source: "telegram", text: GO_REC_AUTH_TEXT });
      expect("ok" in autopilot("Continue with the next step you recommended.")).toBe(true);
    } finally { f.close(); }
  });

  test("refusal precedence and turn rules apply to each source", () => {
    const sources = ["web", "telegram", "autopilot"] as const;
    const actor = { web: "web:loopback", telegram: "telegram:123", autopilot: "autopilot:goal:1" };
    for (const source of sources) {
      const args = (key: string, turn?: number) => ({ key, text: "synthetic answer", source, actor: actor[source],
        ...(turn === undefined ? {} : { answersTurn: turn }) });
      const absent = fixture();
      try {
        expect(absent.broker.submit(args("other|claude|missing", 0))).toEqual({ refused: true, reason: "session_not_found" });
        expect(absent.db.replyCounts().queued).toBe(0);
      } finally { absent.close(); }
      const ended = fixture("claude", "ended");
      try { expect(ended.broker.submit(args(ended.key, 0))).toEqual({ refused: true, reason: "session_ended" }); }
      finally { ended.close(); }
      const dialog = fixture("claude", "needs_input", "question");
      try { expect(dialog.broker.submit(args(dialog.key, 99))).toEqual({ refused: true, reason: "claude_dialog" }); }
      finally { dialog.close(); }
      const approval = fixture("omp", "needs_input", "permission");
      try { expect(approval.broker.submit(args(approval.key, 99))).toEqual({ refused: true, reason: "omp_approval" }); }
      finally { approval.close(); }
      const stale = fixture();
      try {
        expect(stale.broker.submit(args(stale.key, 99))).toEqual({ refused: true, reason: "stale_turn" });
        expect(stale.db.replyCounts().queued).toBe(0);
        expect((stale.db.sqlite.query("SELECT count(*) AS n FROM reply_audit").get() as any).n).toBe(1);
      } finally { stale.close(); }
      for (const harness of ["claude", "omp"] as const) {
        const working = fixture(harness, "working");
        try {
          expect(working.broker.submit(args(working.key, 0))).toEqual({ refused: true, reason: "not_deliverable" });
          if (source !== "autopilot") expect(working.broker.submit(args(working.key))).toMatchObject({ ok: true });
        } finally { working.close(); }
      }
      const ready = fixture();
      try { expect(ready.broker.submit(args(ready.key, 0))).toMatchObject({ ok: true }); }
      finally { ready.close(); }
    }
    const off = fixture();
    try {
      const disabled = createReplies({ db: off.db, enabled: false, setTimer: () => () => {} });
      expect(disabled.submit({ key: off.key, text: "hello", source: "web", actor: "web:loopback" })).toEqual({ refused: true, reason: "disabled" });
      disabled.close();
    } finally { off.close(); }
  });

  test("web, Telegram, and autopilot keep source metadata and exact Claude delivery bodies", async () => {
    const bodies = {
      web: "[dash] The owner replied from the dashboard. Treat this as their next message:\nhello",
      telegram: "[dash] The owner replied from Telegram. Treat this as their next message:\nhello",
      autopilot: "[dash autopilot, not the owner]:\nhello",
    };
    for (const source of ["web", "telegram", "autopilot"] as const) {
      const f = fixture();
      try {
        const reply = f.submit("hello", source, source === "autopilot" ? 0 : undefined);
        expect(reply).toMatchObject({ source, actor: source === "web" ? "web:loopback" :
          source === "telegram" ? "telegram:123" : "autopilot:goal:1", answersTurn: source === "autopilot" ? 0 : null });
        expect(await f.broker.waitClaude(f.key, waiter, 1, 100)).toEqual({ status: 200, reply: bodies[source] });
        expect(f.db.getSession(f.key)?.lastPrompt).toBe(`(reply via ${source})`);
        expect(f.db.getReply(reply.id)?.text).toBe("");
      } finally { f.close(); }
    }
  });
  test("Claude delivery works in both arrival orders, sanitizes, and applies a synthetic prompt", async () => {
    const f = fixture();
    try {
      const first = f.submit("\u0001  hello\towner  ");
      const result = await f.broker.waitClaude(f.key, waiter, 1, 100);
      expect(result).toEqual({ status: 200, reply: "[dash] The owner replied from Telegram. Treat this as their next message:\nhello\towner" });
      expect(f.db.getReply(first.id)?.text).toBe("");
      expect(f.db.getSession(f.key)?.status).toBe("working");
      expect(f.db.getSession(f.key)?.lastPrompt).toBe("(reply via telegram)");
      expect(f.sent).toHaveLength(1);
      f.event("response");
      const pending = f.broker.waitClaude(f.key, waiter, 1, 100);
      f.submit("again");
      expect(await pending).toMatchObject({ status: 200 });
      expect(f.outcomes).toEqual(["delivered", "delivered"]);
    } finally { f.close(); }
  });

  test("working and needs_input Claude sessions hold replies until your_turn", async () => {
    for (const reason of [undefined, "waiting"]) {
      const f = fixture("claude", reason ? "needs_input" : "working", reason);
      try {
        const pending = f.broker.waitClaude(f.key, waiter, 1, 200);
        f.submit("reply");
        expect(f.db.replyCounts().queued).toBe(1);
        f.broker.observe(f.event("response"));
        expect((await pending).status).toBe(200);
      } finally { f.close(); }
    }
  });

  test("supersession selects the newer start and breaks ties for the arrival", async () => {
    const f = fixture();
    try {
      const old = f.broker.waitClaude(f.key, "oldwaiteraaa", 10, 100);
      const newWait = f.broker.waitClaude(f.key, "newwaiter123", 11, 100);
      expect(await old).toEqual({ status: 409 });
      expect(await f.broker.waitClaude(f.key, "lateold1234", 9, 100)).toEqual({ status: 409 });
      const tied = f.broker.waitClaude(f.key, "tiedwaiter12", 11, 100);
      expect(await newWait).toEqual({ status: 409 });
      f.submit("answer");
      expect((await tied).status).toBe(200);
    } finally { f.close(); }
  });

  test("abort leaves reply queued; TTL and end cancel purge text", async () => {
    const f = fixture("claude", "working");
    try {
      const abort = new AbortController();
      const pending = f.broker.waitClaude(f.key, waiter, 1, 100, abort.signal);
      abort.abort();
      expect((await pending).status).toBe(204);
      const expiring = f.submit("secret");
      f.clock.now += 1001; f.sweep();
      expect(f.db.getReply(expiring.id)).toMatchObject({ state: "expired", text: "" });
      const ending = f.submit("secret again");
      const endedWait = f.broker.waitClaude(f.key, waiter, 2, 100);
      f.broker.observe(f.event("session_end"));
      expect(await endedWait).toEqual({ status: 410 });
      expect(f.db.getReply(ending.id)).toMatchObject({ state: "cancelled", text: "" });
      expect(f.outcomes).toEqual(["expired", "cancelled"]);
    } finally { f.close(); }
  });

  test("omp leases, acknowledges, defers, and treats lease expiry as sent", async () => {
    const f = fixture("omp");
    try {
      const first = f.submit("one");
      const received = await f.broker.waitOmp(f.key, waiter, 1, 100);
      expect(received).toEqual({ status: 200, reply: { id: first.id, text: "one", source: "telegram" } });
      expect(f.db.getReply(first.id)).toMatchObject({ state: "leased", text: "one" });
      expect(f.broker.ackOmp(first.id, "wrongwaiter", "sent")).toBe(false);
      expect(f.broker.ackOmp(first.id, waiter, "deferred")).toBe(true);
      expect(f.db.getReply(first.id)?.state).toBe("queued");
      await f.broker.waitOmp(f.key, waiter, 1, 100);
      expect(f.broker.ackOmp(first.id, waiter, "sent")).toBe(true);
      expect(f.db.getReply(first.id)).toMatchObject({ state: "delivered", text: "" });
      const second = f.submit("two");
      await f.broker.waitOmp(f.key, waiter, 1, 100);
      f.clock.now += 60_001; f.sweep();
      expect(f.db.getReply(second.id)).toMatchObject({ state: "delivered", text: "" });
      expect(f.outcomes).toEqual(["delivered", "delivered"]);
    } finally { f.close(); }
  });

  test("OMP question replies bind across the broker to the exact still-pending ask", async () => {
    const f = fixture("omp");
    f.clock.now = Date.now();
    try {
      const turn = f.db.getSession(f.key)!.turnSeq;
      const questionData: NonNullable<NormalizedEvent["questionData"]> = [{ id: "synthetic-choice", question: "Choose a synthetic route?",
        options: [{ label: "1. Synthetic option one" }, { label: "3. Synthetic option three" }, { label: "4. Synthetic option four" }], recommended: 1 }];
      const event = (kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent> = {}) => f.db.applyEvent({
        host: "synthetic-host", harness: "omp", sessionId: "synthetic-session", kind, ts: f.clock.now++, interactive: true, ...extra,
      });
      const submit = (identity: string, text: string) => f.broker.submit({
        key: f.key, text, source: "web", actor: "web:loopback", answersQuestion: identity,
      });
      event("question", { questionIdentity: "question_identity_one", questionData, text: "Choose a synthetic route?" });
      expect(f.broker.submit({ key: f.key, text: "x".repeat(4001), source: "web", actor: "web:loopback", answersQuestion: "question_identity_one" }))
        .toEqual({ refused: true, reason: "invalid_question" });
      expect(f.db.replyCounts().queued).toBe(0);
      expect(f.db.getSession(f.key)?.turnSeq).toBe(turn);
      const stale = submit("question_identity_one", "1. Synthetic option one");
      expect(stale).toMatchObject({ ok: true });
      if (!("ok" in stale)) throw new Error(stale.reason);
      const staleId = stale.replyId;
      event("question", { questionIdentity: "question_identity_two", questionData, text: "Choose another synthetic route?" });
      expect(f.db.getSession(f.key)?.turnSeq).toBe(turn);
      expect(submit("question_identity_one", "stale synthetic answer")).toEqual({ refused: true, reason: "stale_question" });
      const current = submit("question_identity_two", "3. Synthetic option three");
      expect(current).toMatchObject({ ok: true });
      if (!("ok" in current)) throw new Error(current.reason);
      const currentId = current.replyId;

      const leased = await f.broker.waitOmp(f.key, waiter, 1, 100, undefined, true);
      expect(leased).toMatchObject({ status: 200, reply: { id: currentId, text: "3. Synthetic option three", source: "web" } });
      expect(f.db.getReply(staleId)).toMatchObject({ state: "cancelled", cancelReason: "stale_question", text: "" });
      expect(f.broker.commitOmp(currentId, waiter)).toBe(true);
      expect(f.broker.ackOmp(currentId, waiter, "sent")).toBe(true);

      event("question_answered", { questionIdentity: "question_identity_two" });
      expect(submit("question_identity_two", "answered synthetic option")).toEqual({ refused: true, reason: "stale_question" });
      event("question", { questionIdentity: "question_identity_three", questionData, text: "Choose a third synthetic route?" });
      const queued = submit("question_identity_three", "4. Synthetic option four");
      expect(queued).toMatchObject({ ok: true });
      if (!("ok" in queued)) throw new Error(queued.reason);
      event("question_answered", { questionIdentity: "question_identity_three" });
      event("question", { questionIdentity: "question_identity_three", questionData, text: "Late synthetic start" });
      expect(f.db.getSession(f.key)).toMatchObject({ status: "working" });
      expect(f.db.getSession(f.key)?.pendingQuestion).toBeUndefined();
      expect((await f.broker.waitOmp(f.key, waiter, 1, 100, undefined, true)).status).toBe(204);
      expect(f.db.getReply(queued.replyId)).toMatchObject({ state: "cancelled", cancelReason: "stale_question", text: "" });
      event("permission", { text: "synthetic approval" });
      expect(submit("question_identity_two", "approval text")).toEqual({ refused: true, reason: "stale_question" });
      expect(f.broker.submit({ key: f.key, text: "approval text", source: "web", actor: "web:loopback" }))
        .toEqual({ refused: true, reason: "omp_approval" });
      event("session_end");
      expect(submit("question_identity_two", "after session end")).toEqual({ refused: true, reason: "session_ended" });
    } finally { f.close(); }
  });
  test("OMP text replies stay bound when structured question options are unavailable", () => {
    const f = fixture("omp");
    try {
      const identity = "question_identity_unavailable";
      const event = (kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent> = {}) => f.db.applyEvent({
        host: "synthetic-host", harness: "omp", sessionId: "synthetic-session", kind, ts: f.clock.now++, interactive: true, ...extra,
      });
      const turn = f.db.getSession(f.key)!.turnSeq;
      event("question", { questionIdentity: identity, text: "Choose a synthetic answer?" });
      expect(f.db.getSession(f.key)).toMatchObject({ pendingQuestionId: identity });
      expect(f.db.getSession(f.key)?.pendingQuestion).toBeUndefined();
      expect(f.broker.submit({ key: f.key, text: "Synthetic custom answer", source: "web", actor: "web:loopback", answersQuestion: identity }))
        .toMatchObject({ ok: true });
      event("question_answered", { questionIdentity: identity });
      expect(f.broker.submit({ key: f.key, text: "Stale synthetic custom answer", source: "web", actor: "web:loopback", answersQuestion: identity }))
        .toEqual({ refused: true, reason: "stale_question" });
      expect(f.db.getSession(f.key)?.turnSeq).toBe(turn);
    } finally { f.close(); }
  });

  test("omp approval refuses new replies and cancelAll purges an existing queued reply", async () => {
    const f = fixture("omp");
    try {
      const first = f.submit("one");
      f.db.sqlite.query("UPDATE sessions SET status='needs_input',needs_reason='permission' WHERE key=?").run(f.key);
      const pending = f.broker.waitOmp(f.key, waiter, 1, 10);
      expect(f.broker.submit({ key: f.key, text: "two", source: "web", actor: "web:loopback" })).toEqual({ refused: true, reason: "omp_approval" });
      expect(await pending).toEqual({ status: 204 });
      const cancelled = f.broker.cancelAll();
      expect(cancelled).toHaveLength(1);
      expect(f.db.getReply(first.id)).toMatchObject({ state: "cancelled", text: "" });
    } finally { f.close(); }
  });

  test("a moved turn stales a bound Claude reply, while free text survives", async () => {
    const f = fixture();
    try {
      const bound = f.submit("bound", "web", 0);
      f.event("response");
      f.event("response");
      const staleWait = new AbortController();
      const pending = f.broker.waitClaude(f.key, waiter, 1, 500, staleWait.signal);
      expect(f.db.getReply(bound.id)).toMatchObject({ state: "cancelled", cancelReason: "stale", text: "" });
      staleWait.abort();
      expect(await pending).toEqual({ status: 204 });
      const free = f.submit("free", "web");
      expect(await f.broker.waitClaude(f.key, waiter, 2, 100)).toEqual({
        status: 200, reply: "[dash] The owner replied from the dashboard. Treat this as their next message:\nfree",
      });
      expect(f.db.getReply(free.id)?.state).toBe("delivered");
      expect(f.outcomes).toEqual(["cancelled", "delivered"]);
    } finally { f.close(); }
  });

  test("an expired FIFO head does not block a newer ready reply or pending waiter", async () => {
    const f = fixture("claude", "working");
    try {
      const first = f.submit("first", "web");
      f.clock.now += 500;
      const second = f.submit("second", "web");
      const pending = f.broker.waitClaude(f.key, waiter, 1, 500);
      f.clock.now += 600;
      f.db.sqlite.query("UPDATE sessions SET status='your_turn' WHERE key=?").run(f.key);
      f.sweep();
      expect(await pending).toEqual({ status: 200,
        reply: "[dash] The owner replied from the dashboard. Treat this as their next message:\nsecond" });
      expect(f.db.getReply(first.id)?.state).toBe("expired");
      expect(f.db.getReply(second.id)?.state).toBe("delivered");
      expect(f.outcomes).toEqual(["expired", "delivered"]);
    } finally { f.close(); }
  });

  test("owner takes precedence over an uncommitted autopilot lease and commit cannot inject it", async () => {
    const f = fixture("omp", "your_turn", undefined, 120_000);
    try {
      const auto = f.submit("auto", "autopilot", 0);
      const leased = await f.broker.waitOmp(f.key, waiter, 1, 100, undefined, true);
      expect(leased).toEqual({ status: 200, reply: { id: auto.id, text: "auto", source: "autopilot" } });
      const owner = f.submit("owner", "web");
      expect(f.db.getReply(auto.id)).toMatchObject({ state: "cancelled", cancelReason: "owner_replied", text: "" });
      expect(f.broker.commitOmp(auto.id, waiter)).toBe(false);
      expect(f.db.getReply(owner.id)?.state).toBe("queued");
      expect(f.outcomes).toEqual(["cancelled"]);
    } finally { f.close(); }
  });

  test("owner submission cancels only same-session queued auto rows and leaves owner rows intact", () => {
    const f = fixture();
    try {
      const other = f.db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "other",
        kind: "session_start", ts: f.clock.now, interactive: true });
      const otherAuto = f.broker.submit({ key: other.key, text: "other auto", source: "autopilot",
        actor: "autopilot:goal:2", answersTurn: 0 });
      expect(otherAuto).toMatchObject({ ok: true });
      const firstOwner = f.submit("first", "web");
      const auto = f.submit("auto", "autopilot", 0);
      const secondOwner = f.submit("second", "telegram");
      expect(f.db.getReply(auto.id)).toMatchObject({ state: "cancelled", cancelReason: "owner_replied", text: "" });
      expect(f.db.getReply(firstOwner.id)?.state).toBe("queued");
      expect(f.db.getReply(secondOwner.id)?.state).toBe("queued");
      expect(f.db.getReply((otherAuto as { ok: true; replyId: number }).replyId)?.state).toBe("queued");
      f.submit("third", "web");
      expect(f.db.getReply(auto.id)?.state).toBe("cancelled");
      expect(f.outcomes).toEqual(["cancelled"]);
    } finally { f.close(); }
  });

  test("commit and ack are idempotent and a committed lease cannot be cancelled", async () => {
    const f = fixture("omp", "your_turn", undefined, 120_000);
    try {
      const item = f.submit("hello", "web");
      expect((await f.broker.waitOmp(f.key, waiter, 1, 100, undefined, true)).status).toBe(200);
      expect(f.broker.commitOmp(item.id, "wrongwaiter")).toBe(false);
      expect(f.broker.commitOmp(item.id, waiter)).toBe(true);
      expect(f.broker.commitOmp(item.id, waiter)).toBe(true);
      expect(f.broker.cancel(f.key, item.id)).toHaveLength(0);
      expect(f.broker.ackOmp(item.id, waiter, "sent")).toBe(true);
      expect(f.broker.ackOmp(item.id, waiter, "sent")).toBe(true);
      expect(f.outcomes).toEqual(["delivered"]);
      expect(f.db.getReply(item.id)).toMatchObject({ state: "delivered", text: "" });
    } finally { f.close(); }
  });

  test("uncommitted capable leases requeue on timeout, including after broker restart; legacy leases deliver", async () => {
    const f = fixture("omp", "your_turn", undefined, 120_000);
    try {
      const capable = f.submit("capable", "web");
      expect((await f.broker.waitOmp(f.key, waiter, 1, 100, undefined, true)).status).toBe(200);
      f.broker.close();
      const restarted = createReplies({ db: f.db, now: () => f.clock.now, ttlMs: 120_000, setTimer: () => () => {},
        onOutcome: (_reply, result) => f.outcomes.push(result) });
      try {
        expect(restarted.commitOmp(capable.id, waiter)).toBe(false);
        f.clock.now += 60_001;
        restarted.sweep();
        expect(f.db.getReply(capable.id)?.state).toBe("queued");
        expect((await restarted.waitOmp(f.key, waiter, 2, 100, undefined, true)).status).toBe(200);
        expect(restarted.commitOmp(capable.id, waiter)).toBe(true);
        expect(restarted.ackOmp(capable.id, waiter, "sent")).toBe(true);
        expect(f.outcomes).toEqual(["delivered"]);
      } finally { restarted.close(); }
    } finally { f.close(); }

    const legacy = fixture("omp", "your_turn", undefined, 120_000);
    try {
      const item = legacy.submit("legacy");
      expect((await legacy.broker.waitOmp(legacy.key, waiter, 1, 100)).status).toBe(200);
      legacy.clock.now += 60_001;
      legacy.sweep();
      expect(legacy.db.getReply(item.id)?.state).toBe("delivered");
      expect(legacy.outcomes).toEqual(["delivered"]);
    } finally { legacy.close(); }
  });

  test("a legacy omp waiter skips autopilot and can hand out the following owner reply", async () => {
    const f = fixture("omp", "your_turn", undefined, 120_000);
    try {
      const auto = f.submit("auto", "autopilot", 0);
      const owner = f.submit("owner", "web");
      // Owner submission cancels the prior auto row; put another auto behind the owner for the legacy filter.
      const laterAuto = f.submit("later", "autopilot", 0);
      const result = await f.broker.waitOmp(f.key, waiter, 1, 100);
      expect(result).toEqual({ status: 200, reply: { id: owner.id, text: "owner", source: "web" } });
      expect(f.db.getReply(auto.id)?.state).toBe("cancelled");
      expect(f.db.getReply(laterAuto.id)?.state).toBe("queued");
    } finally { f.close(); }
  });
});

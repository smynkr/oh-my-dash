import type { DashDB, Reply, SessionDTO, ReplySource } from "./db.ts";
import { createAudit } from "./audit.ts";
import { GO_REC_AUTH_TEXT } from "./actions.ts";
import type { EventKind, NormalizedEvent } from "./normalize.ts";
import { normalizeQuestionSelections } from "./normalize.ts";
export type { ReplySource } from "./db.ts";
type Harness = "claude" | "omp";
type Outcome = "delivered" | "expired" | "cancelled";
type Listener = "loopback" | "tailnet" | "telegram" | "internal";
type WaitResult = { status: 200; reply: string | { id: number; text: string; source: ReplySource } } | { status: 204 | 409 | 410 };
type Pending = { resolve: (result: WaitResult) => void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void };
type Waiter = { harness: Harness; waiterId: string; started: number; commitCapable: boolean; peer: string; pending?: Pending };
type Lease = { waiterId: string; peer: string };
export type QuestionWaitResult = { status: 200; answers: Record<string, string> } | { status: 204 | 409 | 410 };
type QuestionPending = { resolve: (result: QuestionWaitResult) => void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void };
type QuestionWaiter = { key: string; toolUseId: string; pending?: QuestionPending };

export type SubmitArgs = { key: string; text: string; source: ReplySource; actor: string; answersTurn?: number; answersQuestion?: string; listener?: Listener };
export type RefusalReason = "disabled" | "invalid_key" | "invalid_source" | "invalid_actor" |
  "invalid_text" | "empty_text" | "invalid_turn" | "invalid_question" | "stale_turn" | "stale_question" | "session_not_found" |
  "session_ended" | "claude_dialog" | "omp_approval" | "not_deliverable";
export type SubmitResult = { ok: true; replyId: number } | { refused: true; reason: RefusalReason };
export type RegisterQuestionArgs = { event: NormalizedEvent; id: string; toolUseId: string; timeoutMs: number };
export type QuestionSubmitArgs = { key: string; questionId: string; answers: unknown; source: "web" | "telegram"; actor: string; listener?: Listener };
export type QuestionSubmitResult = { ok: true } | { refused: true; reason: "disabled" | "invalid_key" | "invalid_question" | "invalid_source" | "invalid_actor" | "session_not_found" | "session_ended" | "stale_question" };
export type QuestionRegisterResult =
  | { ok: true; questionId: string; expiresAt: number }
  | { refused: true; reason: "disabled" | "invalid_question" | "session_ended" | "duplicate" };

export interface RepliesOptions {
  db: DashDB;
  enabled?: boolean;
  now?: () => number;
  ttlMs?: number;
  setTimer?: (fn: () => void, ms: number) => () => void;
  onQueued?: (reply: Reply) => void;
  onOutcome?: (reply: Reply, outcome: Outcome, dto?: SessionDTO) => void;
  send?: (dto: SessionDTO, eventKind?: EventKind) => void;
}

const keyPattern = /^[A-Za-z0-9_-]{1,64}\|(claude|omp)\|[A-Za-z0-9_-]{1,128}$/;
const questionIdentityPattern = /^[A-Za-z0-9_-]{8,128}$/;
const claudeQuestionIdentityPattern = /^[A-Za-z0-9_-]{43}$/;
const toolUseIdPattern = /^[A-Za-z0-9_-]{1,256}$/;
const actorPattern: Record<ReplySource, RegExp> = {
  web: /^web:[A-Za-z0-9_-]{1,64}$/,
  telegram: /^telegram:[1-9]\d*$/,
  autopilot: /^autopilot:goal:[1-9]\d*$/,
};
const claudeDialogs = new Set(["question", "permission", "permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]);
// Autopilot may not send the owner's authorization text, or any sentence of it, however it is cased or spaced.
const fold = (text: string) => text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").toLowerCase();
const AUTH_SENTENCES = GO_REC_AUTH_TEXT.split(/(?<=\.) /).map(sentence => fold(sentence).replace(/\.$/, ""));
const carriesAuth = (text: string) => { const folded = fold(text); return AUTH_SENTENCES.some(sentence => folded.includes(sentence)); };
const replyTextLimit = 4000;
const cleanText = (text: string) => [...text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim()].slice(0, replyTextLimit).join("");
const exceedsReplyTextLimit = (text: string) => {
  let points = 0;
  for (const _ of text) if (++points > replyTextLimit) return true;
  return false;
};

export function createReplies({ db, enabled = true, now = Date.now, ttlMs = 900_000, setTimer, onQueued, onOutcome, send }: RepliesOptions) {
  const audit = createAudit(db);
  const waiters = new Map<string, Waiter>();
  const leases = new Map<number, Lease>();
  const acks = new Set<string>();
  const counts = { delivered: 0, expired: 0, cancelled: 0, invalid: 0 };
  const timer = setTimer ?? ((fn: () => void, ms: number) => { const id = setInterval(fn, ms); return () => clearInterval(id); });
  let stopTimer = () => {};

  const finish = (waiter: Waiter, result: WaitResult) => {
    const pending = waiter.pending;
    if (!pending) return;
    waiter.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
    pending.resolve(result);
  };
  const outcome = (reply: Reply, state: Outcome, dto?: SessionDTO) => {
    counts[state]++;
    onOutcome?.(reply, state, dto);
  };
  const syntheticPrompt = (dto: SessionDTO | null | undefined, source: ReplySource) => {
    if (!dto) return;
    const updated = db.applyEvent({ host: dto.host, harness: dto.harness, sessionId: dto.sessionId,
      kind: "prompt", ts: now(), text: `(reply via ${source})`, interactive: dto.interactive,
      cwd: dto.cwd, title: dto.title, transcriptPath: dto.transcriptPath, sessionKind: dto.sessionKind });
    // A delivered reply is the owner's prompt, so observers see it as one (Telegram stops that turn's card).
    send?.(updated, "prompt");
  };
  const claudeBody = (reply: Reply) => reply.source === "autopilot" ? `[dash autopilot, not the owner]:\n${reply.text}` :
    `[dash] The owner replied from ${reply.source === "web" ? "the dashboard" : "Telegram"}. Treat this as their next message:\n${reply.text}`;

  const tryDispatch = (key: string) => {
    const waiter = waiters.get(key);
    if (!waiter?.pending || waiter.pending.signal?.aborted) return;
    const dto = db.getSession(key);
    if (!dto || dto.status === "ended") return;
    while (waiter.pending) {
      const reply = db.nextQueuedReply(key, waiter.harness !== "omp" || waiter.commitCapable);
      if (!reply) return;
      const result = waiter.harness === "claude"
        ? db.takeQueuedForClaude(key, reply.id, dto.turnSeq, now())
        : db.leaseQueuedForOmp(key, reply.id, waiter.waiterId, dto.turnSeq, now(), waiter.commitCapable);
      if (result.kind === "stale") { outcome(result.reply!, "cancelled", db.getSession(key)); continue; }
      if (result.kind === "unavailable" && reply.expiresAt <= now()) {
        for (const expired of db.expireReplies(now())) outcome(expired, "expired", db.getSession(expired.sessionKey));
        continue;
      }
      if (result.kind === "not_ready" || result.kind === "unavailable") return;
      if (!result.reply) return;
      if (waiter.harness === "claude") {
        finish(waiter, { status: 200, reply: claudeBody(result.reply) });
        outcome(result.reply, "delivered", dto);
        syntheticPrompt(dto, result.reply.source);
      } else {
        leases.set(result.reply.id, { waiterId: waiter.waiterId, peer: waiter.peer });
        finish(waiter, { status: 200, reply: { id: result.reply.id, text: result.reply.text, source: result.reply.source } });
      }
      return;
    }
  };
  const wait = (harness: Harness, key: string, waiterId: string, started: number, waitMs: number,
    signal?: AbortSignal, commitCapable = false, peer = "loopback"): Promise<WaitResult> => {
    if (db.getSession(key)?.status === "ended") return Promise.resolve({ status: 410 });
    if (signal?.aborted) return Promise.resolve({ status: 204 });
    const current = waiters.get(key);
    if (current && current.waiterId !== waiterId) {
      if (current.started > started) return Promise.resolve({ status: 409 });
      finish(current, { status: 409 });
    } else if (current?.pending) finish(current, { status: 409 });
    const waiter: Waiter = { harness, waiterId, started, commitCapable, peer };
    waiters.set(key, waiter);
    return new Promise<WaitResult>(resolve => {
      const pending: Pending = { resolve, signal, timer: setTimeout(() => finish(waiter, { status: 204 }), waitMs) };
      pending.abort = () => { finish(waiter, { status: 204 }); if (waiters.get(key) === waiter) waiters.delete(key); };
      signal?.addEventListener("abort", pending.abort, { once: true });
      waiter.pending = pending;
      tryDispatch(key);
    });
  };
  const questionWaiters = new Map<string, QuestionWaiter>();
  const finishQuestionWaiter = (id: string, result: QuestionWaitResult) => {
    const waiter = questionWaiters.get(id);
    if (!waiter) return;
    questionWaiters.delete(id);
    const pending = waiter.pending;
    if (!pending) return;
    waiter.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener("abort",pending.abort);
    pending.resolve(result);
  };
  const cancelQuestion = (id: string, key: string, toolUseId: string, reason: string, status: 409 | 410 = 409) => {
    const dto = db.cancelQuestion(id,key,toolUseId,now(),reason);
    if (!dto) return null;
    finishQuestionWaiter(id,{ status });
    send?.(dto);
    return dto;
  };
  const consumeQuestion = (id: string, key: string, toolUseId: string): QuestionWaitResult | undefined => {
    const consumedAt = now();
    const invocation = db.questionInvocationsForSession(key)
      .find(item => item.id === id && item.toolUseId === toolUseId);
    if (invocation?.state === "answered" && invocation.expiresAt > consumedAt) {
      const dto = db.getSession(key);
      if (dto && dto.status !== "ended" &&
          (dto.status !== "working" || !questionAnswerHasNotMoved(
            key,id,invocation.answeredAt,invocation.lastHookEventAt))) {
        cancelQuestion(id,key,toolUseId,"session_moved");
        return { status:409 };
      }
    }
    const result = db.consumeQuestion(id,key,toolUseId,consumedAt);
    if (result.kind === "pending") return undefined;
    if (result.kind === "taken") return { status: 200, answers: result.answers };
    const status = result.kind === "ended" ? 410 : 409;
    if (result.kind === "expired" || result.kind === "ended") {
      const dto = db.getSession(key);
      if (dto) send?.(dto);
    }
    return { status };
  };
  const waitQuestion = (key: string, id: string, toolUseId: string, waitMs: number,
    signal?: AbortSignal): Promise<QuestionWaitResult> => {
    if (!enabled || !Number.isInteger(waitMs) || waitMs < 1 || waitMs > 55_000) return Promise.resolve({ status: 409 });
    if (signal?.aborted) return Promise.resolve({ status: 204 });
    const dto = db.getSession(key);
    const invocation = db.getQuestionInvocation(id,key,toolUseId);
    if (!invocation) return Promise.resolve({ status: 409 });
    if (!dto || dto.status === "ended") {
      cancelQuestion(id,key,toolUseId,"session_ended",410);
      return Promise.resolve({ status: 410 });
    }
    if (invocation.expiresAt <= now()) {
      cancelQuestion(id,key,toolUseId,"expired");
      return Promise.resolve({ status: 409 });
    }
    if (questionWaiters.has(id)) return Promise.resolve({ status: 409 });
    const result = consumeQuestion(id,key,toolUseId);
    if (result) return Promise.resolve(result);
    const waiter: QuestionWaiter = { key, toolUseId };
    questionWaiters.set(id,waiter);
    const { promise, resolve } = Promise.withResolvers<QuestionWaitResult>();
    const pending: QuestionPending = { resolve,signal,timer:setTimeout(() => finishQuestionWaiter(id,{ status:204 }),waitMs) };
    pending.abort = () => {
      finishQuestionWaiter(id,{ status:204 });
      cancelQuestion(id,key,toolUseId,"hook_disconnected");
    };
    signal?.addEventListener("abort",pending.abort,{ once:true });
    waiter.pending = pending;
    if (signal?.aborted) pending.abort();
    else {
      const arrived = consumeQuestion(id,key,toolUseId);
      if (arrived) finishQuestionWaiter(id,arrived);
    }
    return promise;
  };
  const registerQuestion = (args: RegisterQuestionArgs): QuestionRegisterResult => {
    if (!enabled) return { refused:true,reason:"disabled" };
    const { event,id,toolUseId,timeoutMs } = args, questions = event.questionData;
    let token: Buffer;
    try { token = Buffer.from(id,"base64url"); } catch { return { refused:true,reason:"invalid_question" }; }
    if (event.harness !== "claude" || event.kind !== "question" || !event.interactive ||
        !event.toolUseId || event.toolUseId !== toolUseId || !toolUseIdPattern.test(toolUseId) ||
        !claudeQuestionIdentityPattern.test(id) || token.byteLength !== 32 || token.toString("base64url") !== id ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000 ||
        !questions?.length || !keyPattern.test(`${event.host}|claude|${event.sessionId}`))
      return { refused:true,reason:"invalid_question" };
    const registeredAt = now();
    const result = db.registerQuestion(event,id,toolUseId,questions,registeredAt,timeoutMs);
    if (!result.ok) return { refused:true,reason:result.reason };
    for (const replaced of result.replaced) finishQuestionWaiter(replaced,{ status:409 });
    send?.(result.dto,"question");
    return { ok:true,questionId:id,expiresAt:registeredAt+timeoutMs };
  };
  const cancelled = (items: Reply[], dto?: SessionDTO) => {
    for (const reply of items) { leases.delete(reply.id); outcome(reply, "cancelled", dto ?? db.getSession(reply.sessionKey)); }
    return items;
  };
  const sweep = () => {
    const retry = new Set<string>();
    for (const reply of db.expireReplies(now())) { outcome(reply, "expired", db.getSession(reply.sessionKey)); retry.add(reply.sessionKey); }
    for (const reply of db.expiredLeases(now())) {
      leases.delete(reply.id);
      if (reply.state !== "delivered") { retry.add(reply.sessionKey); continue; }
      const dto = db.getSession(reply.sessionKey);
      outcome(reply, "delivered", dto);
      syntheticPrompt(dto, reply.source);
    }
    for (const key of retry) tryDispatch(key);
    const questionNow = now();
    for (const expired of db.expireQuestions(questionNow)) {
      finishQuestionWaiter(expired.id,{ status:409 });
      send?.(expired.dto);
    }
    db.pruneQuestions(questionNow);
    db.pruneReplies(questionNow);
    audit.prune(questionNow);
  };
  stopTimer = timer(sweep, 30_000);

  const refuse = (reason: RefusalReason, args: SubmitArgs, text?: string, listener?: Listener): SubmitResult => {
    if (text !== undefined && listener) {
      const ts = now();
      audit.record({ ts, sessionKey: args.key, source: args.source,
        actor: args.actor, listener, text, outcome: `refused:${reason}`, outcomeTs: ts });
    }
    else counts.invalid++;
    return { refused: true, reason };
  };
  const refuseQuestion = (reason: "disabled" | "invalid_key" | "invalid_question" | "invalid_source" |
    "invalid_actor" | "session_not_found" | "session_ended" | "stale_question",
    args: QuestionSubmitArgs, listener?: Listener): QuestionSubmitResult => {
    if (listener && (args.source === "web" || args.source === "telegram") && typeof args.actor === "string") {
      let text = "";
      try { text = JSON.stringify(args.answers) ?? ""; } catch {}
      const ts = now();
      audit.record({ ts,sessionKey:args.key,source:args.source,actor:args.actor,listener,text,
        outcome:`refused:${reason}`,outcomeTs:ts });
    } else counts.invalid++;
    return { refused:true,reason };
  };
  const validQuestionId = (id: unknown): id is string => {
    if (typeof id !== "string" || !claudeQuestionIdentityPattern.test(id)) return false;
    try {
      const token = Buffer.from(id,"base64url");
      return token.byteLength === 32 && token.toString("base64url") === id;
    } catch { return false; }
  };
  const eventHasQuestionIdentity = (detail: unknown, id: string) => {
    if (typeof detail !== "string") return false;
    try {
      const parsed: unknown = JSON.parse(detail);
      return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
        "questionIdentity" in parsed && parsed.questionIdentity === id;
    } catch { return false; }
  };
  // last_hook_event_ts advances for duplicate delivery too; only question events for this
  // exact invocation are harmless after its answer. Any other event means the session moved.
  // Event rows are pruned by their supplied timestamp; if the answer row is gone, the
  // session timestamp is the remaining signal that no later hook event moved it.
  const duplicateQuestionEventsAfterAnswer = (key: string, id: string): boolean | undefined => {
    const rows: unknown[] = db.sqlite.query(`SELECT kind,detail FROM events WHERE session_key=? AND id >= (
      SELECT id FROM events WHERE session_key=? AND kind='question_answered' AND detail=? ORDER BY id LIMIT 1
    ) ORDER BY id`).all(key,key,JSON.stringify({ questionIdentity:id }));
    if (!rows.length) return undefined;
    let sawAnswer = false;
    for (const row of rows) {
      if (!row || typeof row !== "object" || !("kind" in row) || !("detail" in row)) return false;
      if (!sawAnswer) {
        if (row.kind !== "question_answered" || !eventHasQuestionIdentity(row.detail,id)) return false;
        sawAnswer = true;
      } else if (row.kind !== "question" || !eventHasQuestionIdentity(row.detail,id)) return false;
    }
    return sawAnswer;
  };
  const questionAnswerHasNotMoved = (key: string, id: string, answeredAt: number | undefined,
    lastHookEventAt: number | undefined) => {
    if (answeredAt === undefined || lastHookEventAt === undefined) return false;
    const history = duplicateQuestionEventsAfterAnswer(key,id);
    return history ?? lastHookEventAt <= answeredAt;
  };
  const observeQuestions = (dto: SessionDTO) => {
    if (dto.status === "ended") {
      for (const cancelled of db.cancelQuestionsForSession(dto.key,now(),"session_ended"))
        finishQuestionWaiter(cancelled.id,{ status:410 });
      return;
    }
    const observedAt = now();
    for (const invocation of db.questionInvocationsForSession(dto.key)) {
      const pending = invocation.state === "pending" && dto.status === "needs_input" &&
        dto.needsReason === "question" && dto.pendingQuestionId === invocation.id;
      const answered = invocation.state === "answered" && dto.status === "working" &&
        invocation.expiresAt > observedAt &&
        questionAnswerHasNotMoved(dto.key,invocation.id,invocation.answeredAt,invocation.lastHookEventAt);
      if (pending || answered) continue;
      db.cancelQuestion(invocation.id,dto.key,invocation.toolUseId,observedAt,
        invocation.expiresAt <= observedAt ? "expired" : "session_moved");
      finishQuestionWaiter(invocation.id,{ status:409 });
    }
  };

  return {
    submit(args: SubmitArgs): SubmitResult {
      if (!enabled) return refuse("disabled", args);
      if (typeof args.key !== "string" || !keyPattern.test(args.key)) return refuse("invalid_key", args);
      if (args.source !== "telegram" && args.source !== "web" && args.source !== "autopilot") return refuse("invalid_source", args);
      if (typeof args.actor !== "string" || !actorPattern[args.source].test(args.actor)) return refuse("invalid_actor", args);
      if (typeof args.text !== "string") return refuse("invalid_text", args);
      if (args.answersQuestion !== undefined && exceedsReplyTextLimit(args.text)) return refuse("invalid_question", args);
      const text = cleanText(args.text);
      if (!text) return refuse("empty_text", args);
      if (args.source === "autopilot" && carriesAuth(text)) return refuse("invalid_source", args);
      if ((args.answersTurn !== undefined && (!Number.isSafeInteger(args.answersTurn) || args.answersTurn < 0)) ||
        (args.source === "autopilot" && args.answersTurn === undefined)) return refuse("invalid_turn", args);
      if (args.answersQuestion !== undefined && (typeof args.answersQuestion !== "string" ||
          !questionIdentityPattern.test(args.answersQuestion) || (args.source !== "web" && args.source !== "telegram") || args.answersTurn !== undefined)) {
        return refuse("invalid_question", args);
      }
      const listener = args.listener ?? (args.source === "telegram" ? "telegram" : args.source === "web" ? "loopback" : "internal");
      const dto = db.getSession(args.key);
      if (!dto) return refuse("session_not_found", args, text, listener);
      if (dto.status === "ended") return refuse("session_ended", args, text, listener);
      if (dto.harness === "claude" && dto.status === "needs_input" && claudeDialogs.has(dto.needsReason ?? ""))
        return refuse("claude_dialog", args, text, listener);
      if (args.answersQuestion !== undefined && (dto.harness !== "omp" || dto.status !== "needs_input" ||
          dto.needsReason !== "question" || dto.pendingQuestionId !== args.answersQuestion))
        return refuse("stale_question", args, text, listener);
      if (dto.harness === "omp" && dto.status === "needs_input" && dto.needsReason === "permission")
        return refuse("omp_approval", args, text, listener);
      if (args.answersTurn !== undefined && args.answersTurn !== dto.turnSeq) return refuse("stale_turn", args, text, listener);
      if (args.answersTurn !== undefined && dto.status !== "your_turn") return refuse("not_deliverable", args, text, listener);
      if (args.source !== "autopilot") cancelled(db.cancelReplies({ key: args.key, source: "autopilot", reason: "owner_replied" }, now()), dto);
      const ts = now();
      const prepared = audit.prepare({ ts, sessionKey: args.key, source: args.source, actor: args.actor, listener, text });
      const reply = db.enqueueReply(args.key, text, args.source, args.actor, args.answersTurn, ts, ttlMs, prepared, args.answersQuestion);
      onQueued?.(reply);
      tryDispatch(args.key);
      return { ok: true, replyId: reply.id };
    },
    submitQuestion(args: QuestionSubmitArgs): QuestionSubmitResult {
      if (!enabled) return refuseQuestion("disabled",args);
      if (typeof args.key !== "string" || !keyPattern.test(args.key)) return refuseQuestion("invalid_key",args);
      if (args.source !== "web" && args.source !== "telegram") return refuseQuestion("invalid_source",args);
      if (typeof args.actor !== "string" || !actorPattern[args.source].test(args.actor))
        return refuseQuestion("invalid_actor",args);
      if (!validQuestionId(args.questionId)) return refuseQuestion("invalid_question",args);
      const listener = args.listener ?? (args.source === "telegram" ? "telegram" : "loopback");
      if (args.source === "telegram" ? listener !== "telegram" : listener !== "loopback" && listener !== "tailnet")
        return refuseQuestion("invalid_actor",args,listener);
      const dto = db.getSession(args.key);
      if (!dto) return refuseQuestion("session_not_found",args,listener);
      if (dto.status === "ended") return refuseQuestion("session_ended",args,listener);
      const invocation = db.getQuestionInvocation(args.questionId,args.key);
      if (!invocation || invocation.state !== "pending" || dto.harness !== "claude" ||
          dto.status !== "needs_input" || dto.needsReason !== "question" || dto.pendingQuestionId !== args.questionId)
        return refuseQuestion("stale_question",args,listener);
      const answers = normalizeQuestionSelections(invocation.questions,args.answers);
      if (!answers) return refuseQuestion("invalid_question",args,listener);
      const ts = now();
      const auditContext = audit.prepare({ ts,sessionKey:args.key,source:args.source,actor:args.actor,listener,
        text:JSON.stringify(answers) });
      const result = db.answerQuestion(invocation.id,args.key,invocation.toolUseId,answers,args.source,args.actor,
        listener,ts,auditContext);
      if (result !== "accepted") {
        if (result === "expired") {
          const current = db.getSession(args.key);
          if (current) send?.(current);
        }
        return refuseQuestion(result === "ended" ? "session_ended" : "stale_question",args,listener);
      }
      const updated = db.getSession(args.key);
      if (updated) send?.(updated,"question_answered");
      const waiter = questionWaiters.get(invocation.id);
      if (waiter?.pending) {
        const delivered = consumeQuestion(invocation.id,args.key,invocation.toolUseId);
        if (delivered) finishQuestionWaiter(invocation.id,delivered);
      }
      return { ok:true };
    },
    cancel(key: string, id?: number) { return cancelled(db.cancelReplies({ key, id, reason: "owner_cancelled" }, now())); },
    cancelAll() { return cancelled(db.cancelReplies({ reason: "owner_cancelled" }, now())); },
    registerQuestion,
    waitQuestion,
    cancelQuestion(id: string,key: string,toolUseId: string) {
      return !!cancelQuestion(id,key,toolUseId,"hook_cancelled");
    },
    waitClaude: (key: string, waiterId: string, started: number, waitMs: number, signal?: AbortSignal) => wait("claude", key, waiterId, started, waitMs, signal),
    waitOmp: (key: string, waiterId: string, started: number, waitMs: number, signal?: AbortSignal, commitCapable = false, peer = "loopback") =>
      wait("omp", key, waiterId, started, waitMs, signal, commitCapable, peer),
    commitOmp(id: number, waiterId: string, peer = "loopback") {
      const lease = leases.get(id);
      if (!lease || lease.waiterId !== waiterId || lease.peer !== peer) return false;
      const result = db.commitOmp(id, waiterId, now());
      if (!result.ok && result.reason === "stale" && result.reply) {
        leases.delete(id);
        outcome(result.reply, "cancelled", db.getSession(result.reply.sessionKey));
      }
      return result.ok;
    },
    ackOmp(id: number, waiterId: string, answer: "sent" | "deferred", peer = "loopback") {
      const ackKey = `${id}:${waiterId}:${peer}:${answer}`;
      if (acks.has(ackKey)) return true;
      const lease = leases.get(id);
      if (!lease || lease.waiterId !== waiterId || lease.peer !== peer) return false;
      const reply = answer === "sent" ? db.ackReply(id, now()) : db.deferReply(id, now());
      if (!reply) return false;
      leases.delete(id);
      acks.add(ackKey);
      if (acks.size > 1000) acks.delete(acks.values().next().value!);
      if (answer === "sent") {
        const dto = db.getSession(reply.sessionKey);
        outcome(reply, "delivered", dto);
        syntheticPrompt(dto, reply.source);
      } else tryDispatch(reply.sessionKey);
      return true;
    },
    observe(dto: SessionDTO) {
      observeQuestions(dto);
      if (dto.status === "ended") {
        cancelled(db.cancelReplies({ key: dto.key, reason: "ended" }, now()), dto);
        const waiter = waiters.get(dto.key);
        if (waiter) { finish(waiter, { status: 410 }); waiters.delete(dto.key); }
      } else tryDispatch(dto.key);
    },
    sweep,
    health() {
      const count = db.replyCounts();
      const active = [...waiters.values()].filter(w => w.pending);
      return { enabled, queued: count.queued, leased: count.leased,
        waiters: { claude: active.filter(w => w.harness === "claude").length, omp: active.filter(w => w.harness === "omp").length }, ...counts };
    },
    close() {
      stopTimer();
      for (const [id,waiter] of questionWaiters) {
        db.cancelQuestion(id,waiter.key,waiter.toolUseId,now(),"hub_closed");
        finishQuestionWaiter(id,{ status:410 });
      }
      for (const waiter of waiters.values()) finish(waiter,{ status:410 });
      waiters.clear(); leases.clear();
    },
  };
}

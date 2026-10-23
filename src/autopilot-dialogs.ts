import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { QuestionInvocation, SessionDTO } from "./db.ts";
import type { AskQuestion } from "./normalize.ts";
import { matchStopAndAsk } from "./autopilot-policy.ts";
import { AUTOPILOT_DELAY_CHOICES, type AutopilotGoal, type AutopilotStore } from "./autopilot-store.ts";

export const DIALOG_HOOK_MAX_FUTURE_MS = 610_000; // 605-second helper timeout plus five seconds of client/server clock-skew slack.
export const DIALOG_METRIC_MAX_ELAPSED_MS = DIALOG_HOOK_MAX_FUTURE_MS;
const MAX_DELAYED_DIALOGS = 512;
const MAX_METRIC_COUNT = Number.MAX_SAFE_INTEGER;
const COOLDOWN_MS = 120_000;
const AUTO_REPLY_RATE_LIMIT = 30;

export type AutopilotDialogEnvironment = Readonly<Record<string, string | undefined>>;
export type AutopilotDialogGateFailure = "disabled" | "incomplete" | "invalid_e5" | "invalid_hold_min";
export type AutopilotDialogGate =
  | Readonly<{ enabled: true; askHoldMin: number; e5MaxHoldMs: number }>
  | Readonly<{ enabled: false; reason: AutopilotDialogGateFailure }>;

function positiveInteger(value: string | undefined, min: number, max: number): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

/** Reads the owner-recorded experiment attestations once, at server startup. */
export function parseAutopilotDialogGate(env: AutopilotDialogEnvironment): AutopilotDialogGate {
  if (!env || typeof env !== "object") return { enabled: false, reason: "incomplete" };
  if (env.DASH_DIALOGS !== "1" || env.DASH_AUTOPILOT !== "1" || env.DASH_REPLIES !== "1")
    return { enabled: false, reason: "disabled" };
  if (env.DASH_DIALOGS_E3_PASS !== "1" || env.DASH_DIALOGS_E4_PASS !== "1")
    return { enabled: false, reason: "incomplete" };
  const e5MaxHoldMs = positiveInteger(env.DASH_DIALOGS_E5_MAX_HOLD_MS, 1_000, 600_000);
  if (e5MaxHoldMs === undefined) return { enabled: false, reason: "invalid_e5" };
  const askHoldMin = env.DASH_ASK_HOLD_MIN === undefined
    ? 10
    : positiveInteger(env.DASH_ASK_HOLD_MIN, 1, 10);
  if (askHoldMin === undefined) return { enabled: false, reason: "invalid_hold_min" };
  return { enabled: true, askHoldMin, e5MaxHoldMs };
}

/** Returns the startup gate's bounded budget after validating the absolute server-time hook deadline. */
export function dialogHoldBudgetMs(
  gate: AutopilotDialogGate,
  now: number,
  hookDeadlineMs: number,
): number | undefined {
  if (!gate.enabled || !Number.isSafeInteger(gate.askHoldMin) || gate.askHoldMin < 1 || gate.askHoldMin > 10 ||
      !Number.isSafeInteger(gate.e5MaxHoldMs) || gate.e5MaxHoldMs < 1_000 || gate.e5MaxHoldMs > 600_000 ||
      !Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(hookDeadlineMs) || hookDeadlineMs <= now ||
      hookDeadlineMs - now > DIALOG_HOOK_MAX_FUTURE_MS) return undefined;
  const remainingHookMs = hookDeadlineMs - now;
  const budget = Math.min(gate.askHoldMin * 60_000, gate.e5MaxHoldMs, remainingHookMs);
  return Number.isSafeInteger(budget) && budget > 0 ? budget : undefined;
}

export type DialogMetricKind =
  | "released"
  | "owner_hold"
  | "delayed_hold"
  | "answered"
  | "owner_answered"
  | "terminal_released"
  | "expired"
  | "stale"
  | "replaced"
  | "hold_failed";

export interface AutopilotDialogMetrics {
  attempts: number;
  outcomes: Record<DialogMetricKind, number>;
  elapsedMs: { samples: number; total: number; max: number };
}

export interface AutopilotDialogMetricSample {
  outcome: DialogMetricKind;
  elapsedMs: number;
}

export interface DialogAutopilotMetadata {
  goal_id: number;
  expires_at: number;
  remaining_ttl_ms: number;
}

export interface AskHookRegistration {
  toolName: string;
  sessionKey: string;
  host: string;
  toolUseId: string;
  invocationId: string;
  questions: AskQuestion[];
  /** Absolute Unix epoch deadline captured by the blocking helper, in milliseconds. */
  hookDeadlineMs: number;
}

export type DialogReleaseReason =
  | "gate"
  | "deadline"
  | "invalid_request"
  | "stale"
  | "expired"
  | "owner_pending"
  | "unavailable"
  | "no_goal"
  | "disabled"
  | "inactive_goal"
  | "budget"
  | "stop_ask"
  | "recommendation"
  | "never"
  | "cooldown"
  | "rate"
  | "delay_cap"
  | "duplicate"
  | "hold_unavailable";

export interface DialogHoldPlan {
  mode: "owner" | "autopilot_delay";
  sessionKey: string;
  host: string;
  toolUseId: string;
  invocationId: string;
  questionId: string;
  expiresAt: number;
  answerAt?: number;
  goalId?: number;
}

export type AutopilotDialogDecision =
  | { action: "release"; reason: DialogReleaseReason }
  | {
      action: "hold";
      invocationId: string;
      questionId: string;
      expiresAt: number;
      mode: "owner" | "autopilot_delay";
      answerAt?: number;
      autopilot?: DialogAutopilotMetadata;
    }
  | {
      action: "answer";
      invocationId: string;
      source: "autopilot";
      answers: Record<string, string>;
      autopilot: DialogAutopilotMetadata;
    };

/** Only bounded scheduling metadata safe to return to the Claude hook. */
export type AutopilotDialogHookResponse =
  | { action: "release" }
  | {
      action: "hold";
      invocationId: string;
      questionId: string;
      expiresAt: number;
      answerAt?: number;
      autopilot?: DialogAutopilotMetadata;
    }
  | {
      action: "answer";
      invocationId: string;
      source: "autopilot";
      answers: Record<string, string>;
      autopilot: DialogAutopilotMetadata;
    };

export function autopilotDialogHookResponse(decision: AutopilotDialogDecision): AutopilotDialogHookResponse {
  if (decision.action === "release") return { action: "release" };
  if (decision.action === "hold") return {
    action: "hold",
    invocationId: decision.invocationId,
    questionId: decision.questionId,
    expiresAt: decision.expiresAt,
    ...(decision.answerAt === undefined ? {} : { answerAt: decision.answerAt }),
    ...(decision.autopilot ? { autopilot: decision.autopilot } : {}),
  };
  return {
    action: "answer",
    invocationId: decision.invocationId,
    source: "autopilot",
    answers: decision.answers,
    autopilot: decision.autopilot,
  };
}


export interface AutopilotDialogStore extends Pick<AutopilotStore,
  "goalForSession" | "masterEnabled" | "away" | "customStopPhrases" | "ownerReplyPending" |
  "lastCommittedReplyAt" | "committedRepliesLastHour"> {}

export interface AutopilotDialogsOptions {
  store: AutopilotDialogStore;
  now?: () => number;
  gateEnv?: AutopilotDialogEnvironment;
  getSession: (sessionKey: string) => SessionDTO | undefined;
  getInvocation: (invocationId: string, sessionKey: string, toolUseId: string) => QuestionInvocation | undefined;
  /** Synchronous notification/scheduling hook. It receives identifiers and times only, never dialog text. */
  postHold?: (plan: DialogHoldPlan) => void;
  /** Fixed-schema, text-free measurement hook. */
  onMetric?: (sample: AutopilotDialogMetricSample) => void;
}

export type AutopilotDialogIdentity = Pick<AskHookRegistration,
  "invocationId" | "sessionKey" | "host" | "toolUseId" | "questions">;

export interface AutopilotDialogs {
  hasRegisteredInvocation(sessionKey: string, invocationId: string): boolean;
  register(request: AskHookRegistration): AutopilotDialogDecision;
  resolveDelayedAnswer(request: AskHookRegistration): AutopilotDialogDecision;
  cancelDelayedAnswer(
    identity: AutopilotDialogIdentity,
    outcome: "terminal_released" | "expired" | "stale" | "replaced",
    elapsedMs?: number,
  ): boolean;
  takeElapsed(invocationId: string): number | undefined;
  observeOutcome(outcome: "owner_answered" | "terminal_released" | "expired" | "stale" | "replaced", elapsedMs: number): void;
  metrics(): AutopilotDialogMetrics;
}

interface CurrentInvocation {
  session: SessionDTO;
  invocation: QuestionInvocation;
  questionFingerprint: string;
}

interface PendingAutopilotDelay {
  sessionKey: string;
  host: string;
  toolUseId: string;
  invocationId: string;
  questionFingerprint: string;
  hookDeadlineMs: number;
  turnSeq: number;
  goalId: number;
  delayMin: number;
  answerAt: number;
  expiresAt: number;
  startedAt: number | undefined;
}
interface IssuedDialog {
  fingerprint: string;
  sessionKey: string;
  expiresAt: number;
  startedAt: number | undefined;
}

interface AutoEligibility {
  goal: AutopilotGoal;
  delayMin: number;
  answers: Record<string, string>;
  autopilot: DialogAutopilotMetadata;
}

const initialOutcomes = (): Record<DialogMetricKind, number> => ({
  released: 0, owner_hold: 0, delayed_hold: 0, answered: 0, owner_answered: 0,
  terminal_released: 0, expired: 0, stale: 0, replaced: 0, hold_failed: 0,
});
const nextCount = (value: number) => value >= MAX_METRIC_COUNT ? MAX_METRIC_COUNT : value + 1;
const validClock = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

function validText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || !!value.trim()) &&
    Buffer.byteLength(value, "utf8") <= maxBytes && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

function validQuestions(value: unknown): value is AskQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return false;
  const questionIds = new Set<string>();
  const questionTexts = new Set<string>();
  const cleanQuestions: AskQuestion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const question = raw as AskQuestion;
    if (!validText(question.id, 256) || !validText(question.question, 8_192) ||
        questionIds.has(question.id) || questionTexts.has(question.question) ||
        !Array.isArray(question.options) || question.options.length < 1 || question.options.length > 64) return false;
    questionIds.add(question.id);
    questionTexts.add(question.question);
    const clean: AskQuestion = { id: question.id, question: question.question, options: [] };
    if (question.header !== undefined) {
      if (!validText(question.header, 1_024)) return false;
      clean.header = question.header;
    }
    if (question.multi !== undefined) {
      if (typeof question.multi !== "boolean") return false;
      clean.multi = question.multi;
    }
    if (Number.isSafeInteger(question.recommended) && question.recommended! >= 0 &&
        question.recommended! < question.options.length) clean.recommended = question.recommended;
    const labels = new Set<string>();
    for (const rawOption of question.options) {
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return false;
      const option = rawOption as AskQuestion["options"][number];
      if (!validText(option.label, 2_048) || labels.has(option.label)) return false;
      labels.add(option.label);
      const normalizedOption: AskQuestion["options"][number] = { label: option.label };
      if (option.description !== undefined) {
        if (!validText(option.description, 4_096, true)) return false;
        normalizedOption.description = option.description;
      }
      if (option.preview !== undefined) {
        if (!validText(option.preview, 8_192, true)) return false;
        normalizedOption.preview = option.preview;
      }
      clean.options.push(normalizedOption);
    }
    cleanQuestions.push(clean);
  }
  return Buffer.byteLength(JSON.stringify(cleanQuestions), "utf8") <= 32 * 1024;
}

function questionFingerprint(questions: readonly AskQuestion[]): string {
  const canonical = questions.map(question => [
    question.id,
    question.question,
    question.header ?? null,
    question.multi ?? null,
    Number.isSafeInteger(question.recommended) && question.recommended! >= 0 &&
      question.recommended! < question.options.length ? question.recommended : null,
    question.options.map(option => [option.label, option.description ?? null, option.preview ?? null]),
  ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
function registrationFingerprint(request: AskHookRegistration): string {
  return createHash("sha256").update(JSON.stringify([
    request.sessionKey, request.host, request.toolUseId, request.invocationId,
    request.hookDeadlineMs, questionFingerprint(request.questions),
  ])).digest("hex");
}

function validRegistration(value: unknown): value is AskHookRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as AskHookRegistration;
  return request.toolName === "AskUserQuestion" && validText(request.sessionKey, 512) &&
    validText(request.host, 64) && validText(request.toolUseId, 256) &&
    validText(request.invocationId, 256) && validQuestions(request.questions) &&
    Number.isSafeInteger(request.hookDeadlineMs);
}

function sameQuestions(left: readonly AskQuestion[], right: readonly AskQuestion[]): boolean {
  return validQuestions(left) && validQuestions(right) && questionFingerprint(left) === questionFingerprint(right);
}

function isAutopilotDelay(value: number | null): value is number {
  return value !== null && AUTOPILOT_DELAY_CHOICES.includes(value as typeof AUTOPILOT_DELAY_CHOICES[number]);
}

function stopText(questions: readonly AskQuestion[]): string {
  const parts: string[] = [];
  for (const question of questions) {
    parts.push(question.question, question.header ?? "");
    for (const option of question.options)
      parts.push(option.label, option.description ?? "", option.preview ?? "");
  }
  return parts.join("\n");
}

function recommendationAnswers(questions: readonly AskQuestion[]): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  for (const question of questions) {
    const index = question.recommended;
    if (!Number.isSafeInteger(index) || index! < 0 || index! >= question.options.length) return undefined;
    const selected = question.options[index!];
    if (!selected || typeof selected.label !== "string") return undefined;
    entries.push([question.question, selected.label]);
  }
  return Object.fromEntries(entries);
}

function autopilotMetadata(goal: AutopilotGoal, now: number): DialogAutopilotMetadata | undefined {
  const remaining = goal.expiresAt - now;
  if (!Number.isSafeInteger(goal.id) || goal.id < 1 || !validClock(goal.expiresAt) ||
      !Number.isSafeInteger(remaining) || remaining <= 0) return undefined;
  return { goal_id: goal.id, expires_at: goal.expiresAt, remaining_ttl_ms: remaining };
}

export function createAutopilotDialogs(options: AutopilotDialogsOptions): AutopilotDialogs {
  const nowFn = options.now ?? Date.now;
  let gate: AutopilotDialogGate;
  try { gate = Object.freeze(parseAutopilotDialogGate(options.gateEnv ?? process.env)); }
  catch { gate = Object.freeze({ enabled: false, reason: "incomplete" }); }
  const pending = new Map<string, PendingAutopilotDelay>();
  const issued = new Map<string, IssuedDialog>();
  const outcomes = initialOutcomes();
  let attempts = 0;
  let elapsedSamples = 0;
  let elapsedTotal = 0;
  let elapsedMax = 0;

  const readNow = (): number | undefined => {
    try {
      const value = nowFn();
      return validClock(value) ? value : undefined;
    } catch { return undefined; }
  };

  const record = (outcome: DialogMetricKind, elapsedMs: number): void => {
    outcomes[outcome] = nextCount(outcomes[outcome]);
    const elapsed = Number.isFinite(elapsedMs)
      ? Math.min(DIALOG_METRIC_MAX_ELAPSED_MS, Math.max(0, Math.floor(elapsedMs))) : 0;
    elapsedSamples = nextCount(elapsedSamples);
    elapsedTotal = Math.min(MAX_METRIC_COUNT, elapsedTotal + elapsed);
    elapsedMax = Math.max(elapsedMax, elapsed);
    try { options.onMetric?.({ outcome, elapsedMs: elapsed }); } catch { /* Metrics never affect a safety decision. */ }
  };

  const elapsedSince = (start: number | undefined): number => {
    if (start === undefined) return 0;
    const end = readNow();
    return end === undefined ? 0 : Math.max(0, Math.min(DIALOG_METRIC_MAX_ELAPSED_MS, end - start));
  };

  const released = (reason: DialogReleaseReason, start: number | undefined): AutopilotDialogDecision => {
    const outcome: DialogMetricKind = reason === "expired" ? "expired" : reason === "stale" ? "stale" : "released";
    record(outcome, elapsedSince(start));
    return { action: "release", reason };
  };

  const verifyCurrent = (request: AskHookRegistration, now: number): CurrentInvocation | DialogReleaseReason => {
    let session: SessionDTO | undefined;
    let invocation: QuestionInvocation | undefined;
    try {
      session = options.getSession(request.sessionKey);
      invocation = options.getInvocation(request.invocationId, request.sessionKey, request.toolUseId);
    } catch { return "unavailable"; }
    if (!session || !invocation || session.key !== request.sessionKey || session.host !== request.host ||
        session.harness !== "claude" || session.status === "ended" || session.status !== "needs_input" ||
        session.needsReason !== "question" || session.pendingQuestionId !== request.invocationId ||
        !Number.isSafeInteger(session.turnSeq) || session.turnSeq < 0 ||
        invocation.id !== request.invocationId || invocation.sessionKey !== request.sessionKey ||
        invocation.toolUseId !== request.toolUseId || invocation.state !== "pending") return "stale";
    if (!validClock(invocation.createdAt) || invocation.createdAt > now || !validClock(invocation.expiresAt)) return "stale";
    if (invocation.expiresAt <= now) return "expired";
    if (!sameQuestions(request.questions, invocation.questions)) return "stale";
    return { session, invocation, questionFingerprint: questionFingerprint(request.questions) };
  };

  const validateHoldWindow = (
    invocation: QuestionInvocation,
    now: number,
    budgetMs: number,
  ): { expiresAt: number; budgetMs: number } | DialogReleaseReason => {
    const actualBudgetMs = Math.min(budgetMs, invocation.expiresAt - now);
    const expiresAt = now + actualBudgetMs;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return "deadline";
    return { expiresAt, budgetMs: actualBudgetMs };
  };

  const postHold = (plan: DialogHoldPlan): boolean => {
    try {
      options.postHold?.(plan);
      return true;
    } catch { return false; }
  };

  const held = (
    plan: DialogHoldPlan,
    start: number | undefined,
    autopilot?: DialogAutopilotMetadata,
  ): AutopilotDialogDecision => {
    if (!postHold(plan)) {
      record("hold_failed", elapsedSince(start));
      return released("hold_unavailable", start);
    }
    record(plan.mode === "owner" ? "owner_hold" : "delayed_hold", elapsedSince(start));
    return {
      action: "hold",
      invocationId: plan.invocationId,
      questionId: plan.questionId,
      expiresAt: plan.expiresAt,
      mode: plan.mode,
      ...(plan.answerAt === undefined ? {} : { answerAt: plan.answerAt }),
      ...(autopilot ? { autopilot } : {}),
    };
  };

  const ownerReplyIsPending = (sessionKey: string): boolean | DialogReleaseReason => {
    try {
      const pendingReply = options.store.ownerReplyPending(sessionKey);
      return typeof pendingReply === "boolean" ? pendingReply : "unavailable";
    } catch { return "unavailable"; }
  };

  const readAway = (): boolean | DialogReleaseReason => {
    try {
      const away = options.store.away();
      return typeof away === "boolean" ? away : "unavailable";
    } catch { return "unavailable"; }
  };

  const autoEligibility = (
    request: AskHookRegistration,
    current: CurrentInvocation,
    now: number,
    expected?: Pick<PendingAutopilotDelay, "goalId" | "delayMin">,
  ): AutoEligibility | DialogReleaseReason => {
    let master: boolean;
    let goal: AutopilotGoal | undefined;
    let customPhrases: string[];
    let lastReplyAt: number | null;
    let repliesLastHour: number;
    try {
      master = options.store.masterEnabled();
      if (typeof master !== "boolean") return "unavailable";
      if (!master) return "disabled";
      goal = options.store.goalForSession(request.sessionKey);
      if (!goal) return "no_goal";
      if (goal.sessionKey !== request.sessionKey || goal.status !== "active") return "inactive_goal";
      if (expected && (goal.id !== expected.goalId || goal.delayMin !== expected.delayMin)) return "stale";
      if (!Number.isSafeInteger(goal.turnSeqAtResume) || goal.turnSeqAtResume < 0 ||
          current.session.turnSeq < goal.turnSeqAtResume) return "stale";
      if (!Number.isSafeInteger(goal.maxTurns) || goal.maxTurns < 1 || goal.maxTurns > 20 ||
          !Number.isSafeInteger(goal.turnsUsed) || goal.turnsUsed < 0 || !validClock(goal.expiresAt)) return "unavailable";
      if (goal.turnsUsed >= goal.maxTurns || goal.expiresAt <= now) return "budget";
      if (goal.delayMin === null) return "never";
      if (!isAutopilotDelay(goal.delayMin)) return "never";
      customPhrases = options.store.customStopPhrases();
      if (!Array.isArray(customPhrases) || customPhrases.length > 64 ||
          customPhrases.some(phrase => typeof phrase !== "string" || !phrase.trim() || Array.from(phrase).length > 120))
        return "unavailable";
      if (matchStopAndAsk(stopText(current.invocation.questions), customPhrases)) return "stop_ask";
      const answers = recommendationAnswers(current.invocation.questions);
      if (!answers) return "recommendation";
      lastReplyAt = options.store.lastCommittedReplyAt(request.sessionKey, now);
      if (lastReplyAt !== null && (!validClock(lastReplyAt) || now - lastReplyAt < COOLDOWN_MS)) return "cooldown";
      repliesLastHour = options.store.committedRepliesLastHour(now);
      if (!Number.isSafeInteger(repliesLastHour) || repliesLastHour < 0) return "unavailable";
      if (repliesLastHour >= AUTO_REPLY_RATE_LIMIT) return "rate";
      const autopilot = autopilotMetadata(goal, now);
      if (!autopilot) return "unavailable";
      return { goal, delayMin: goal.delayMin, answers, autopilot };
    } catch { return "unavailable"; }
  };
  const pruneIssued = (now: number): void => {
    for (const [id, entry] of issued) if (entry.expiresAt <= now) issued.delete(id);
  };

  const markIssued = (request: AskHookRegistration, expiresAt: number, startedAt: number | undefined): boolean => {
    if (issued.size >= MAX_DELAYED_DIALOGS) return false;
    issued.set(request.invocationId, { fingerprint: registrationFingerprint(request), sessionKey: request.sessionKey, expiresAt, startedAt });
    return true;
  };

  const register = (request: AskHookRegistration): AutopilotDialogDecision => {
    const startedAt = readNow();
    attempts = nextCount(attempts);
    if (!gate.enabled) return released("gate", startedAt);
    const now = readNow();
    if (now === undefined) return released("unavailable", startedAt);
    if (!validRegistration(request)) return released("invalid_request", startedAt);
    const baseBudgetMs = dialogHoldBudgetMs(gate, now, request.hookDeadlineMs);
    if (baseBudgetMs === undefined) return released("deadline", startedAt);
    pruneIssued(now);
    const checked = verifyCurrent(request, now);
    if (typeof checked === "string") return released(checked, startedAt);
    const previous = issued.get(request.invocationId);
    if (previous) return released(previous.fingerprint === registrationFingerprint(request) ? "duplicate" : "replaced", startedAt);
    const ownerPending = ownerReplyIsPending(request.sessionKey);
    if (typeof ownerPending === "string") return released(ownerPending, startedAt);
    if (ownerPending) return released("owner_pending", startedAt);
    const away = readAway();
    if (typeof away === "string") return released(away, startedAt);
    const window = validateHoldWindow(checked.invocation, now, baseBudgetMs);
    if (typeof window === "string") return released(window, startedAt);

    if (away) {
      if (!markIssued(request, window.expiresAt, startedAt)) return released("unavailable", startedAt);
      const decision = held({
        mode: "owner", sessionKey: request.sessionKey, host: request.host, toolUseId: request.toolUseId,
        invocationId: request.invocationId, questionId: request.invocationId, expiresAt: window.expiresAt,
      }, startedAt);
      if (decision.action === "release") issued.delete(request.invocationId);
      return decision;
    }

    const eligible = autoEligibility(request, checked, now);
    if (typeof eligible === "string") return released(eligible, startedAt);
    if (eligible.delayMin === 0) {
      if (!markIssued(request, window.expiresAt, startedAt)) return released("unavailable", startedAt);
      record("answered", elapsedSince(startedAt));
      return {
        action: "answer", invocationId: request.invocationId, source: "autopilot",
        answers: eligible.answers, autopilot: eligible.autopilot,
      };
    }
    const delayMs = eligible.delayMin * 60_000;
    // The answer must arrive before the hook's expiry, not at the instant the helper times out.
    if (!Number.isSafeInteger(delayMs) || delayMs >= window.budgetMs) return released("delay_cap", startedAt);
    const answerAt = now + delayMs;
    if (!Number.isSafeInteger(answerAt) || answerAt >= window.expiresAt) return released("delay_cap", startedAt);
    for (const [id, delayed] of pending) if (delayed.expiresAt <= now) pending.delete(id);
    if (pending.has(request.invocationId)) return released("duplicate", startedAt);
    if (pending.size >= MAX_DELAYED_DIALOGS) return released("unavailable", startedAt);
    const pendingDelay: PendingAutopilotDelay = {
      sessionKey: request.sessionKey, host: request.host, toolUseId: request.toolUseId,
      invocationId: request.invocationId, questionFingerprint: checked.questionFingerprint,
      hookDeadlineMs: request.hookDeadlineMs, turnSeq: checked.session.turnSeq,
      goalId: eligible.goal.id, delayMin: eligible.delayMin, answerAt, expiresAt: window.expiresAt, startedAt,
    };
    pending.set(request.invocationId, pendingDelay);
    if (!markIssued(request, window.expiresAt, startedAt)) {
      pending.delete(request.invocationId);
      return released("unavailable", startedAt);
    }
    const decision = held({
      mode: "autopilot_delay", sessionKey: request.sessionKey, host: request.host,
      toolUseId: request.toolUseId, invocationId: request.invocationId, questionId: request.invocationId,
      expiresAt: window.expiresAt, answerAt, goalId: eligible.goal.id,
    }, startedAt, eligible.autopilot);
    if (decision.action === "release") {
      pending.delete(request.invocationId);
      issued.delete(request.invocationId);
    }
    return decision;
  };

  const resolveDelayedAnswer = (request: AskHookRegistration): AutopilotDialogDecision => {
    const startedAt = readNow();
    attempts = nextCount(attempts);
    if (!gate.enabled) return released("gate", startedAt);
    const now = readNow();
    if (now === undefined) return released("unavailable", startedAt);
    if (!validRegistration(request)) return released("invalid_request", startedAt);
    const delayed = pending.get(request.invocationId);
    if (!delayed) return released("stale", startedAt);
    if (delayed.sessionKey !== request.sessionKey || delayed.host !== request.host ||
        delayed.toolUseId !== request.toolUseId || delayed.invocationId !== request.invocationId ||
        delayed.hookDeadlineMs !== request.hookDeadlineMs ||
        delayed.questionFingerprint !== questionFingerprint(request.questions)) return released("stale", startedAt);
    if (now >= delayed.expiresAt || request.hookDeadlineMs <= now) {
      pending.delete(request.invocationId);
      return released("expired", startedAt);
    }
    const checked = verifyCurrent(request, now);
    if (typeof checked === "string") {
      pending.delete(request.invocationId);
      return released(checked, startedAt);
    }
    if (checked.session.turnSeq !== delayed.turnSeq) {
      pending.delete(request.invocationId);
      return released("stale", startedAt);
    }
    const ownerPending = ownerReplyIsPending(request.sessionKey);
    if (typeof ownerPending === "string") {
      pending.delete(request.invocationId);
      return released(ownerPending, startedAt);
    }
    if (ownerPending) {
      pending.delete(request.invocationId);
      return released("owner_pending", startedAt);
    }
    const away = readAway();
    if (typeof away === "string") {
      pending.delete(request.invocationId);
      return released(away, startedAt);
    }
    if (away) {
      pending.delete(request.invocationId);
      const ownerPlan: DialogHoldPlan = {
        mode: "owner", sessionKey: request.sessionKey, host: request.host, toolUseId: request.toolUseId,
        invocationId: request.invocationId, questionId: request.invocationId, expiresAt: delayed.expiresAt,
      };
      return held(ownerPlan, startedAt);
    }
    const eligible = autoEligibility(request, checked, now, delayed);
    if (typeof eligible === "string") {
      pending.delete(request.invocationId);
      return released(eligible, startedAt);
    }
    if (eligible.delayMin !== delayed.delayMin) {
      pending.delete(request.invocationId);
      return released("stale", startedAt);
    }
    if (now < delayed.answerAt) return {
      action: "hold", invocationId: request.invocationId, questionId: request.invocationId,
      expiresAt: delayed.expiresAt, mode: "autopilot_delay", answerAt: delayed.answerAt,
      autopilot: eligible.autopilot,
    };
    pending.delete(request.invocationId);
    record("answered", elapsedSince(delayed.startedAt));
    return {
      action: "answer", invocationId: request.invocationId, source: "autopilot",
      answers: eligible.answers, autopilot: eligible.autopilot,
    };
  };

  const cancelDelayedAnswer = (
    identity: AutopilotDialogIdentity,
    outcome: "terminal_released" | "expired" | "stale" | "replaced",
    elapsedMs?: number,
  ): boolean => {
    const delayed = pending.get(identity.invocationId);
    if (!delayed || delayed.sessionKey !== identity.sessionKey || delayed.host !== identity.host ||
        delayed.toolUseId !== identity.toolUseId || !validQuestions(identity.questions) ||
        delayed.questionFingerprint !== questionFingerprint(identity.questions)) return false;
    pending.delete(identity.invocationId);
    const startedAt = issued.get(identity.invocationId)?.startedAt ?? delayed.startedAt;
    issued.delete(identity.invocationId);
    record(outcome, elapsedMs ?? elapsedSince(startedAt));
    return true;
  };
  const takeElapsed = (invocationId: string): number | undefined => {
    if (!issued.has(invocationId)) return undefined;
    const start = issued.get(invocationId)!.startedAt;
    issued.delete(invocationId);
    return elapsedSince(start);
  };

  const observeOutcome = (
    outcome: "owner_answered" | "terminal_released" | "expired" | "stale" | "replaced",
    elapsedMs: number,
  ): void => record(outcome, elapsedMs);

  const metrics = (): AutopilotDialogMetrics => ({
    attempts,
    outcomes: { ...outcomes },
    elapsedMs: { samples: elapsedSamples, total: elapsedTotal, max: elapsedMax },
  });
  const hasRegisteredInvocation = (sessionKey: string, invocationId: string): boolean => {
    const entry = issued.get(invocationId), now = readNow();
    return !!entry && entry.sessionKey === sessionKey && now !== undefined && entry.expiresAt > now;
  };

  return { gate, hasRegisteredInvocation, register, resolveDelayedAnswer, cancelDelayedAnswer, takeElapsed, observeOutcome, metrics };
}

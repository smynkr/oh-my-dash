import { describePrompt, type NormalizedEvent } from "./normalize.ts";

export type Status = "working" | "needs_input" | "your_turn" | "ended" | "unknown";
export interface SessionState {
  status: Status;
  needsReason?: string | null;
  needsText?: string | null;
  lastPrompt?: string | null;
  lastError?: string | null;
  lastNotification?: string | null;
  backgroundPending?: boolean;
  pendingQuestionId?: string | null;
  lastActivity: number;
}

const promptingNotifications: Record<string, true> = {
  permission_prompt: true, elicitation_dialog: true, elicitation_url_dialog: true,
};
export function reduceState(previous: SessionState, event: NormalizedEvent): SessionState {
  const next = { ...previous, lastActivity: event.ts };
  switch (event.kind) {
    case "session_start":
      if (!event.detail || ["startup", "resume", "clear", "fork"].includes(event.detail)) {
        next.status = "your_turn";
        next.pendingQuestionId = null;
      }
      break;
    case "prompt": next.status = "working"; next.needsReason = null; next.needsText = null; next.pendingQuestionId = null; next.lastPrompt = describePrompt(event.text); next.backgroundPending = false; break;
    case "question":
      next.status = "needs_input"; next.needsReason = "question"; next.needsText = event.text ?? null;
      next.pendingQuestionId = event.questionIdentity ?? null;
      break;
    case "permission": next.status = "needs_input"; next.needsReason = "permission"; next.needsText = event.text ?? null; next.pendingQuestionId = null; break;
    case "question_answered":
      if (previous.pendingQuestionId && previous.pendingQuestionId !== event.questionIdentity ||
          event.questionIdentity && previous.pendingQuestionId !== event.questionIdentity) break;
      next.status = "working"; next.needsReason = null; next.needsText = null; next.pendingQuestionId = null;
      break;
    case "notification": next.lastNotification = event.text ?? null; if (event.detail && Object.hasOwn(promptingNotifications, event.detail) && !(next.status === "needs_input" && next.needsReason === "question")) { next.status = "needs_input"; next.needsReason = event.detail; next.needsText = event.text ?? null; next.pendingQuestionId = null; } break;
    case "response": next.status = "your_turn"; next.needsReason = null; next.needsText = null; next.pendingQuestionId = null; next.backgroundPending = (event.backgroundTasks ?? 0) > 0; break;
    case "error": next.status = "your_turn"; next.needsReason = null; next.needsText = null; next.pendingQuestionId = null; next.lastError = event.text ?? null; break;
    case "session_end": next.status = "ended"; next.needsReason = null; next.needsText = null; next.pendingQuestionId = null; break;
  }
  return next;
}

export function reduceLiveness(previous: SessionState, liveness: string | undefined, now: number, lastHookEventTs?: number): SessionState {
  const age = lastHookEventTs == null ? Infinity : now - lastHookEventTs;
  const next = { ...previous };
  if (previous.status === "ended") return next;
  if (liveness === "busy" && (previous.status === "unknown" ||
    (previous.status === "your_turn" && age > 20_000) ||
    (previous.status === "needs_input" && ["permission", "permission_prompt"].includes(previous.needsReason ?? "") && age > 20_000))) {
    next.status = "working"; next.needsReason = null; next.needsText = null;
  } else if (liveness === "idle" && (previous.status === "unknown" || (previous.status === "working" && age > 60_000))) {
    next.status = "your_turn"; next.needsReason = null; next.needsText = null;
  } else if (liveness === "waiting" && ["unknown", "working", "your_turn"].includes(previous.status) && age > 10_000) {
    next.status = "needs_input"; next.needsReason = "waiting"; next.needsText = "Waiting for your input";
  }
  return next;
}

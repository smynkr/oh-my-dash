import type { SessionDTO } from "./db.ts";

export type CapabilityStatus = "supported" | "unavailable" | "unknown";
export type CapabilityAction = { status: CapabilityStatus; reason: string; code?: string };
export type DeliveryProtocol = "claude-waiter" | "omp-commit" | "omp-legacy";
export type DeliveryObservation = { observedAt: number; expiresAt: number; protocol: DeliveryProtocol };
export type SessionCapabilities = {
  evaluatedAt: number;
  actions: {
    view: CapabilityAction;
    message: CapabilityAction;
    structuredQuestion: CapabilityAction;
    approve: CapabilityAction;
    interrupt: CapabilityAction;
    resume: CapabilityAction;
    launch: CapabilityAction;
  };
  delivery: { status: "observed" | "unknown" | "unavailable"; reason: string; observedAt?: number; expiresAt?: number; protocol?: DeliveryProtocol };
};
export type SessionWithCapabilities = SessionDTO & { capabilities: SessionCapabilities };
export type CapabilitySession = Pick<SessionDTO, "key" | "harness" | "status" | "needsReason">;
export type MessageRefusalReason = "disabled" | "invalid_key" | "session_ended" | "claude_dialog" | "omp_approval";

const claudeDialogs: Record<string, true> = {
  question: true,
  permission: true,
  permission_prompt: true,
  elicitation_dialog: true,
  elicitation_url_dialog: true,
};

const replyKeyPattern = /^[A-Za-z0-9_-]{1,64}\|(claude|omp)\|[A-Za-z0-9_-]{1,128}$/;
export function isReplyKey(value: unknown): value is string {
  return typeof value === "string" && replyKeyPattern.test(value);
}

/** The single source of truth for queueing refusals and the corresponding message capability. */
export function messageRefusalReason(session: CapabilitySession | null | undefined, enabled: boolean): MessageRefusalReason | undefined {
  if (!enabled) return "disabled";
  if (!session) return undefined;
  if (!isReplyKey(session.key)) return "invalid_key";
  if (session.status === "ended") return "session_ended";
  if (session.harness === "claude" && session.status === "needs_input" && claudeDialogs[session.needsReason ?? ""] === true) return "claude_dialog";
  if (session.harness === "omp" && session.status === "needs_input" && session.needsReason === "permission") return "omp_approval";
  return undefined;
}

const unavailable = (reason: string, code = "not_exposed"): CapabilityAction => ({ status: "unavailable", reason, code });

export function sessionCapabilities(session: CapabilitySession, enabled: boolean, observation: DeliveryObservation | undefined, now: number): SessionCapabilities {
  const refusal = messageRefusalReason(session, enabled);
  const message: CapabilityAction = refusal ? {
    status: "unavailable",
    code: refusal,
    reason: refusal === "disabled" ? "Replies are disabled; Dash will not accept a message into its queue."
      : refusal === "invalid_key" ? "This session identifier cannot be routed by Dash's reply protocol; retained output remains readable."
      : refusal === "session_ended" ? "The session has ended; Dash will not accept a message."
        : refusal === "claude_dialog" ? "Claude's native dialog must be answered in Claude Code or Remote Control; Dash refuses queued text here."
          : "OMP's native approval must be answered in the session; Dash refuses queued text here.",
  } : {
    status: "supported",
    reason: "Dash accepts ordinary text into its bounded reply queue; queue acceptance does not guarantee delivery.",
  };

  const claudeDialog = session.harness === "claude" && session.status === "needs_input" && claudeDialogs[session.needsReason ?? ""] === true;
  const structuredQuestion: CapabilityAction = session.harness === "omp"
    ? { status: "unknown", code: "feature_unreported", reason: "OMP commit=1 does not report the installed native ask/abort feature or version. Ordinary queued text is not a structured native answer." }
    : claudeDialog
      ? unavailable("Claude native question, permission and elicitation dialogs require an answer in Claude Code or Remote Control; Dash has no structured native-answer API.", "claude_dialog")
      : unavailable("Dash does not expose Claude's structured native question-answer API; ordinary queued text only steers the conversation.");

  const delivery = !enabled
    ? { status: "unavailable" as const, reason: "Replies are disabled; Dash does not register delivery waiters." }
    : session.status === "ended"
      ? { status: "unavailable" as const, reason: "The session has ended; message delivery is not available." }
      : observation && observation.expiresAt > now
        ? { status: "observed" as const, reason: "A reply waiter is presently pending; this is a delivery-path observation, not confirmation of source liveness or message delivery.",
          observedAt: observation.observedAt, expiresAt: observation.expiresAt, protocol: observation.protocol }
        : { status: "unknown" as const, reason: "No unexpired pending reply waiter is observed; source connectivity is unknown." };

  return {
    evaluatedAt: now,
    actions: {
      view: { status: "supported", reason: "Retained session output can be viewed; this does not establish current source liveness." },
      message,
      structuredQuestion,
      approve: unavailable("Dash does not expose a remote approval control; answer native prompts in the session."),
      interrupt: unavailable("Dash does not expose a remote interrupt control."),
      resume: unavailable("Dash can display a resume command but does not remotely resume a session."),
      launch: unavailable("Dash does not launch sessions."),
    },
    delivery,
  };
}

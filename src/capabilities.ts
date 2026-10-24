import type { SessionDTO } from "./db.ts";
import type { CodexAction } from "./normalize.ts";

export type CapabilityStatus = "supported" | "unavailable" | "unknown";
export type CapabilityAction = { status: CapabilityStatus; reason: string; code?: string };
export type DeliveryProtocol = "claude-waiter" | "omp-commit" | "omp-legacy" | "codex-control";
export type DeliveryObservation = { observedAt: number; expiresAt: number; protocol: DeliveryProtocol };
export type SessionCapabilities = {
  evaluatedAt: number;
  actions: {
    view: CapabilityAction;
    message: CapabilityAction;
    steer: CapabilityAction;
    structuredQuestion: CapabilityAction;
    approve: CapabilityAction;
    interrupt: CapabilityAction;
    resume: CapabilityAction;
    launch: CapabilityAction;
  };
  delivery: { status: "observed" | "unknown" | "unavailable"; reason: string; observedAt?: number; expiresAt?: number; protocol?: DeliveryProtocol };
};
export type SessionWithCapabilities = SessionDTO & { capabilities: SessionCapabilities };
export type CapabilitySession = Pick<SessionDTO, "key" | "harness" | "status" | "needsReason" | "codexControl">;
export type MessageRefusalReason = "disabled" | "invalid_key" | "session_ended" | "claude_dialog" | "omp_approval" | "codex_disabled" | "codex_not_owned";

const claudeDialogs: Record<string, true> = {
  question: true,
  permission: true,
  permission_prompt: true,
  elicitation_dialog: true,
  elicitation_url_dialog: true,
};

const replyKeyPattern = /^[A-Za-z0-9_-]{1,64}\|(claude|omp|codex)\|[A-Za-z0-9_-]{1,128}$/;
export function isReplyKey(value: unknown): value is string {
  return typeof value === "string" && replyKeyPattern.test(value);
}

/** The single source of truth for queueing refusals and the corresponding message capability. */
export function messageRefusalReason(session: CapabilitySession | null | undefined, enabled: boolean, codexEnabled = false,
  codexAction?: CodexAction): MessageRefusalReason | undefined {
  if (!enabled) return "disabled";
  if (!session) return undefined;
  if (!isReplyKey(session.key)) return "invalid_key";
  if (session.status === "ended") return "session_ended";
  if (session.harness === "codex") {
    if (!codexEnabled) return "codex_disabled";
    if (!session.codexControl || !session.codexControl.appServerOwned && codexAction !== "turn/start") return "codex_not_owned";
  }
  if (session.harness === "claude" && session.status === "needs_input" && claudeDialogs[session.needsReason ?? ""] === true) return "claude_dialog";
  if (session.harness === "omp" && session.status === "needs_input" && session.needsReason === "permission") return "omp_approval";
  return undefined;
}

const unavailable = (reason: string, code = "not_exposed"): CapabilityAction => ({ status: "unavailable", reason, code });
function codexControlCapability(session: CapabilitySession, codexEnabled: boolean, repliesEnabled: boolean,
  action: "turn/steer" | "turn/interrupt"): CapabilityAction {
  if (session.harness !== "codex") return unavailable("This control is available only for Codex app-server sessions.", "unsupported_control");
  if (session.status === "ended") return unavailable("The session has ended; Dash will not accept Codex controls.", "session_ended");
  if (!repliesEnabled) return unavailable("Replies are disabled; Dash will not accept Codex controls.", "disabled");
  if (!codexEnabled) return unavailable("Codex controls are disabled; DASH_CODEX must be enabled on the Dash console server.", "codex_disabled");
  const control = session.codexControl;
  if (!control?.appServerOwned)
    return unavailable("Steer and interrupt require a thread loaded or resumed by this Codex app-server; standalone sessions are read-only.", "codex_not_owned");
  if (!control.activeTurnId) return unavailable("No active Codex turn is observed; steer and interrupt require a target turn.", "no_active_turn");
  if (action === "turn/steer" && !control.turnSteer)
    return unavailable("The installed Codex app-server does not advertise turn/steer support.", "unsupported_control");
  if (action === "turn/interrupt" && !control.turnInterrupt)
    return unavailable("The installed Codex app-server does not advertise turn/interrupt support.", "unsupported_control");
  return { status: "supported", reason: `Codex ${action} is supported for the observed active turn ${control.activeTurnId}.` };
}

export function sessionCapabilities(session: CapabilitySession, enabled: boolean, observation: DeliveryObservation | undefined, now: number,
  codexEnabled = false): SessionCapabilities {
  const refusal = messageRefusalReason(session, enabled, codexEnabled, session.harness === "codex" ? "turn/start" : undefined);
  const message: CapabilityAction = refusal ? {
    status: "unavailable",
    code: refusal,
    reason: refusal === "disabled" ? "Replies are disabled; Dash will not accept a message into its queue."
      : refusal === "invalid_key" ? "This session identifier cannot be routed by Dash's reply protocol; retained output remains readable."
      : refusal === "session_ended" ? "The session has ended; Dash will not accept a message."
      : refusal === "claude_dialog" ? "Claude's native dialog must be answered in Claude Code or Remote Control; Dash refuses queued text here."
      : refusal === "omp_approval" ? "OMP's native approval must be answered in the session; Dash refuses queued text here."
      : refusal === "codex_disabled" ? "Codex control is disabled; enable DASH_CODEX on the Dash console server."
      : "This Codex thread is not owned by this app-server; only a listed thread's turn/start may attempt to resume it.",
  } : session.harness === "codex"
    ? session.status === "ended"
      ? unavailable("The session has ended; Dash will not accept Codex controls.", "session_ended")
      : session.codexControl?.activeTurnId
        ? unavailable("A Codex turn is active; use steer or interrupt instead of starting another turn.", "turn_active")
        : session.codexControl?.turnStart
          ? { status: "supported", reason: "Dash queues `turn/start`; if this listed thread is not loaded, its source first attempts `thread/resume`. Queue acceptance does not guarantee a resume or turn start." }
          : unavailable("The installed Codex app-server does not advertise turn/start support.", "unsupported_control")
    : {
      status: "supported",
      reason: "Dash accepts ordinary text into its bounded reply queue; queue acceptance does not guarantee delivery.",
    };
  const codexDialog = session.harness === "codex";
  const claudeDialog = session.harness === "claude" && session.status === "needs_input" && claudeDialogs[session.needsReason ?? ""] === true;
  const structuredQuestion: CapabilityAction = codexDialog
    ? unavailable("Codex approval and user-input requests are surfaced, but Dash does not implement native responses; respond in the Codex session.", "codex_user_input_unsupported")
    : session.harness === "omp"
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
      steer: codexControlCapability(session, codexEnabled, enabled, "turn/steer"),
      structuredQuestion,
      approve: codexDialog
        ? unavailable("Codex approvals are surfaced, but Dash never grants them; answer approval requests in the Codex session.", "codex_approval_unsupported")
        : unavailable("Dash does not expose a remote approval control; answer native prompts in the session."),
      interrupt: session.harness === "codex"
        ? codexControlCapability(session, codexEnabled, enabled, "turn/interrupt")
        : unavailable("Dash does not expose a remote interrupt control."),
      resume: session.harness === "codex"
        ? unavailable("Dash cannot attach to standalone Codex CLI or Desktop sessions; only threads owned by this local app-server are controllable.", "codex_not_attachable")
        : unavailable("Dash can display a resume command but does not remotely resume a session."),
      launch: unavailable("Dash does not launch sessions."),
    },
    delivery,
  };
}

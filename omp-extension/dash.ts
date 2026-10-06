/**
 * OMP dashboard feed extension.
 * API checked against can1357/oh-my-pi tag v18.2.11
 * (commit e4151593ace2781d1dc2f06d760301f88af3e9dc):
 * packages/coding-agent/src/extensibility/extensions/types.ts and
 * packages/coding-agent/src/extensibility/shared-events.ts (tag v18.2.11).
 * The tag documents pi.on handlers, pi.getSessionName(), ctx.mode/ctx.cwd/sessionManager,
 * tool_execution_start/end, tool approvals, agent_end, session_stop, and input.
 * Ask tool input checked against v18.6.1 packages/coding-agent/src/tools/ask.ts.
 * Its questions carry id/question/header, options (label/description/preview), multi, and a zero-based recommended index.
 */
import { hostname } from "node:os";

type AnyRecord = Record<string, any>;
type Context = AnyRecord;
type Pi = {
  on: (name: string, handler: (event: AnyRecord, ctx: Context) => unknown) => void;
  getSessionName?: () => string | undefined;
  sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
};

export function resolveHost(env: { DASH_HOST?: string }, hostnameFn: () => string = hostname): string {
  const override = env.DASH_HOST;
  if (typeof override === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(override)) return override;
  return hostnameFn().split(".")[0] || "localhost";
}
const DEFAULT_URL = "http://127.0.0.1:4777/ingest/omp";

type DeliveryChoice = "defer" | "answer_ask" | "prompt" | "followUp";
type ReplySource = "telegram" | "web" | "autopilot";

export function chooseDelivery({ idle, askPending, approvals }: { idle: boolean; askPending: boolean; approvals: number }): DeliveryChoice {
  if (approvals > 0) return "defer";
  if (askPending) return "answer_ask";
  if (idle) return "prompt";
  return "followUp";
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener("abort", onAbort); resolve(); }
  function onAbort() { clearTimeout(timer); done(); }
  signal?.addEventListener("abort", onAbort, { once: true });
});

function sessionKey(event: AnyRecord, ctx: Context): string { return getSessionId(event, ctx); }

function replyBase(): string {
  const configured = process.env.DASH_REPLY_URL;
  if (configured) return configured.replace(/\/$/, "");
  try { return new URL(process.env.DASH_URL || DEFAULT_URL).origin; }
  catch { return new URL(DEFAULT_URL).origin; }
}

function textBlocks(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as AnyRecord).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: AnyRecord) => block && block.type === "text" && typeof block.text === "string")
    .map((block: AnyRecord) => block.text as string)
    .join("");
}

function getSessionId(event: AnyRecord, ctx: Context): string {
  try {
    const fromManager = ctx?.sessionManager?.getSessionId?.();
    if (typeof fromManager === "string" && fromManager) return fromManager;
  } catch { /* Fall back to event/session metadata. */ }
  try {
    const header = ctx?.sessionManager?.getHeader?.();
    if (typeof header?.id === "string" && header.id) return header.id;
  } catch { /* Fall through. */ }
  return typeof event?.session_id === "string" ? event.session_id
    : typeof event?.sessionId === "string" ? event.sessionId : "";
}

function isInteractive(ctx: Context): boolean {
  try {
    // hasUI also includes ACP; only TUI represents an attached UI/TTY.
    return ctx?.mode === "tui";
  } catch {
    return false;
  }
}

function install(pi: Pi): void {
  const host = resolveHost(process.env);
  const seenResponses = new Set<string>();
  const seenQuestions = new Set<string>();
  const ctxBySession = new Map<string, Context>();
  const askPending = new Map<string, Set<string>>();
  const questionIdentityBySession = new Map<string, Map<string, string>>();
  const approvals = new Map<string, number>();
  const loops = new Map<string, AbortController>();

  function rememberContext(event: AnyRecord, ctx: Context): string {
    const id = sessionKey(event, ctx);
    if (id) ctxBySession.set(id, ctx);
    return id;
  }

  function startReplyLoop(sid: string): void {
    if (!sid || loops.has(sid) || !pi.sendUserMessage) return;
    const controller = new AbortController();
    loops.set(sid, controller);
    const started = Math.floor(Date.now() / 1000);
    const waiter = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    void runReplyLoop(sid, waiter, started, controller).catch(() => {}).finally(() => {
      if (loops.get(sid) === controller) loops.delete(sid);
    });
  }

  function reportReplyCode(code: string): void {
    try { console.error(`dash ${code}`); } catch { /* Local reporting must not affect the session. */ }
  }

  async function commitReply(id: number, waiter: string, startedAt: number, signal: AbortSignal): Promise<boolean> {
    let backoff = 250;
    while (!signal.aborted) {
      const remaining = 60_000 - (Date.now() - startedAt);
      if (remaining <= 0) return false;
      try {
        const response = await fetch(`${replyBase()}/reply/commit`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Dash-Host": host },
          body: JSON.stringify({ id, waiter }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(10_000, remaining))]),
        });
        if (response.status === 200) {
          try { return (await response.json() as { ok?: boolean })?.ok === true; }
          catch { return false; }
        }
        if (response.status === 404 || response.status === 409 || response.status < 500) return false;
      } catch {
        if (signal.aborted) return false;
      }
      const waitMs = Math.min(backoff, Math.max(0, 60_000 - (Date.now() - startedAt)));
      if (waitMs <= 0) return false;
      await sleep(waitMs, signal);
      backoff = Math.min(backoff * 2, 5000);
    }
    return false;
  }

  function replyPrefix(source: ReplySource, answerAsk: boolean): string {
    if (source === "autopilot") return "[dash autopilot, not the owner]:\n";
    const origin = source === "web" ? "from the dashboard" : "from Telegram";
    return `[dash] The owner replied ${origin}${answerAsk ? ", answering your pending question" : ""}:\n`;
  }

  async function runReplyLoop(sid: string, waiter: string, started: number, controller: AbortController): Promise<void> {
    let backoff = 5000;
    while (!controller.signal.aborted) {
      try {
        const url = new URL(`${replyBase()}/reply/wait/omp`);
        url.search = new URLSearchParams({ session: sid, waiter, started: String(started), wait: "50", commit: "1" }).toString();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
        const response = await fetch(url, { headers: { "X-Dash-Host": host }, signal });
        if (response.status === 204) { backoff = 5000; continue; }
        if (response.status === 404) { await sleep(300_000, controller.signal); continue; }
        if (response.status === 409 || response.status === 410) return;
        if (response.status >= 500) { await sleep(backoff, controller.signal); backoff = Math.min(backoff * 2, 60_000); continue; }
        if (response.status !== 200) { await sleep(5000, controller.signal); continue; }
        backoff = 5000;
        const leasedAt = Date.now();
        const payload = await response.json() as { id?: number; text?: string; source?: ReplySource };
        const replyId = payload?.id;
        const source = payload?.source;
        if (typeof replyId !== "number" || !Number.isSafeInteger(replyId) || replyId <= 0 || typeof payload?.text !== "string" ||
            (source !== "telegram" && source !== "web" && source !== "autopilot")) continue;
        const ctx = ctxBySession.get(sid);
        let outcome: "sent" | "deferred" = "deferred";
        if (ctx) {
          const pendingIds = [...(askPending.get(sid) || [])];
          const choice = chooseDelivery({
            idle: safeIdle(ctx), askPending: pendingIds.length > 0,
            approvals: approvals.get(sid) || 0,
          });
          if (choice === "defer") {
            outcome = "deferred";
          } else {
            const prefix = replyPrefix(source, choice === "answer_ask");
            const committed = await commitReply(replyId, waiter, leasedAt, controller.signal);
            if (!committed) continue;
            let sendThrew = false;
            try {
              if (choice === "prompt") pi.sendUserMessage!(prefix + payload.text);
              else if (choice === "followUp") pi.sendUserMessage!(prefix + payload.text, { deliverAs: "followUp" });
              else {
                pi.sendUserMessage!(prefix + payload.text, { deliverAs: "steer" });
                const deadline = Date.now() + 1000;
                while (Date.now() < deadline && !controller.signal.aborted && hasRememberedAsk(sid, pendingIds)) {
                  await sleep(50, controller.signal);
                }
                const askStillPending = hasRememberedAsk(sid, pendingIds);
                const abortGate = typeof ctx.hasPendingMessages === "function" ? safeHasPending(ctx) : askStillPending;
                let abortFailure = false;
                if (askStillPending && abortGate) {
                  if (typeof ctx.abort !== "function") {
                    reportReplyCode("omp_ask_abort_unavailable");
                    abortFailure = true;
                  } else {
                    try { ctx.abort(); }
                    catch { reportReplyCode("omp_ask_abort_failed"); abortFailure = true; }
                  }
                }
                if (hasRememberedAsk(sid, pendingIds) && !abortFailure) reportReplyCode("omp_ask_still_pending");
                if ((approvals.get(sid) || 0) > 0) reportReplyCode("omp_approval_after_commit");
              }
              outcome = "sent";
            } catch { sendThrew = true; }
            if (sendThrew) {
              reportReplyCode("omp_send_uncertain");
              continue;
            }
          }
        }
        try {
          await fetch(`${replyBase()}/reply/ack`, {
            method: "POST", headers: { "content-type": "application/json", "X-Dash-Host": host },
            body: JSON.stringify({ id: replyId, waiter, outcome }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
          });
        } catch { /* Keep the session loop isolated from hub failures. */ }
        if (outcome === "deferred") await sleep(5000, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
        await sleep(backoff, controller.signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  function safeIdle(ctx: Context): boolean { try { return ctx?.isIdle?.() === true; } catch { return false; } }
  function safeHasPending(ctx: Context): boolean {
    try {
      const pending = ctx?.hasPendingMessages?.();
      if (typeof pending === "boolean") return pending;
      if (pending instanceof Set) return pending.size > 0;
      if (Array.isArray(pending)) return pending.length > 0;
    } catch { /* Ignore optional context API errors. */ }
    return false;
  }
  function hasRememberedAsk(sid: string, ids: string[]): boolean {
    const pending = askPending.get(sid);
    return ids.some((id) => pending?.has(id));
  }

  function emit(kind: string, event: AnyRecord = {}, ctx: Context = {}, text?: string, detail?: string,
    questionIdentity?: string, questionData?: unknown): void {
    try {
      const interactive = isInteractive(ctx);
      if (!interactive && process.env.DASH_ALLOW_HEADLESS !== "1") return;
      const sessionId = getSessionId(event, ctx);
      if (!sessionId) return;
      const body: AnyRecord = {
        host,
        harness: "omp",
        sessionId,
        kind,
        cwd: typeof ctx?.cwd === "string" ? ctx.cwd : undefined,
        title: typeof pi.getSessionName?.() === "string" ? pi.getSessionName() : undefined,
        text,
        detail,
        questionIdentity,
        questionData,
        interactive,
      };
      const url = process.env.DASH_URL || DEFAULT_URL;
      // Intentionally detached from the event callback: network latency cannot hold the agent.
      void fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    } catch { /* Feed failures must never affect the agent session. */ }
  }
  pi.on("tool_execution_start", (event, ctx) => {
    try {
      const sid = rememberContext(event, ctx);
      if (event?.toolName !== "ask") return;
      const id = String(event.toolCallId || "");
      let identity: string | undefined;
      if (id) {
        identity = crypto.randomUUID().replace(/-/g, "");
        seenQuestions.add(`${sid}:${id}`);
        const identities = questionIdentityBySession.get(sid) || new Map<string, string>();
        identities.set(id, identity);
        questionIdentityBySession.set(sid, identities);
        const pending = askPending.get(sid) || new Set<string>();
        pending.add(id);
        askPending.set(sid, pending);
      }
      const args = event.args && typeof event.args === "object" ? event.args as AnyRecord : {};
      const question = typeof args.question === "string" ? args.question
        : Array.isArray(args.questions) ? args.questions.map((q: AnyRecord) => q?.question).filter((q: unknown) => typeof q === "string").join("\n")
        : "";
      emit("question", event, ctx, question || JSON.stringify(args), undefined, identity,
        identity && Array.isArray(args.questions) ? args.questions : undefined);
    } catch { /* Never escape OMP callbacks. */ }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    try {
      const sid = rememberContext(event, ctx);
      const id = String(event?.toolCallId || "");
      const callKey = `${sid}:${id}`;
      if (event?.toolName === "ask" && (!id || seenQuestions.has(callKey))) {
        if (id) seenQuestions.delete(callKey);
        if (id) askPending.get(sid)?.delete(id);
        const identity = id ? questionIdentityBySession.get(sid)?.get(id) : undefined;
        if (id) questionIdentityBySession.get(sid)?.delete(id);
        emit("question_answered", event, ctx, undefined, undefined, identity);
      }
    } catch { /* Never escape OMP callbacks. */ }
  });

  pi.on("session_start", (event, ctx) => {
    try {
      emit("session_start", event, ctx);
      const id = rememberContext(event, ctx);
      if (isInteractive(ctx)) startReplyLoop(id);
    } catch { /* Never escape OMP callbacks. */ }
  });

  pi.on("input", (event, ctx) => {
    try {
      rememberContext(event, ctx);
      if (event?.source === "interactive" && typeof event.text === "string") {
        const id = getSessionId(event, ctx);
        for (const key of seenResponses) if (key.startsWith(`${id}:`)) seenResponses.delete(key);
        emit("prompt", event, ctx, event.text);
      }
    } catch { /* Never escape OMP callbacks. */ }
  });


  pi.on("tool_approval_requested", (event, ctx) => {
    try {
      const sid = rememberContext(event, ctx);
      approvals.set(sid, (approvals.get(sid) || 0) + 1);
      emit("permission", event, ctx, undefined, typeof event?.toolName === "string" ? event.toolName : undefined);
    }
    catch { /* Never escape OMP callbacks. */ }
  });

  pi.on("tool_approval_resolved", (event, ctx) => {
    try {
      const sid = rememberContext(event, ctx);
      approvals.set(sid, Math.max(0, (approvals.get(sid) || 0) - 1));
      emit("question_answered", event, ctx);
    } catch { /* Never escape OMP callbacks. */ }
  });

  const response = (event: AnyRecord, ctx: Context, messages: unknown): void => {
    try {
      const finalMessage = Array.isArray(messages)
        ? [...messages].reverse().find((message: AnyRecord) => message?.role === "assistant")
        : undefined;
      const content = textBlocks(finalMessage);
      if (!content) return;
      const id = getSessionId(event, ctx);
      const key = `${id}:${content}`;
      if (seenResponses.has(key)) return;
      seenResponses.add(key);
      if (seenResponses.size > 100) seenResponses.delete(seenResponses.values().next().value as string);
      emit("response", event, ctx, content);
    } catch { /* Never escape OMP callbacks. */ }
  };

  pi.on("agent_end", (event, ctx) => {
    try {
      rememberContext(event, ctx);
      if (event?.willContinue === true) return;
      response(event, ctx, event?.messages);
    } catch { /* Never escape OMP callbacks. */ }
  });

  pi.on("session_stop", (event, ctx) => {
    try { rememberContext(event, ctx); response(event, ctx, event?.last_assistant_message ? [event.last_assistant_message] : event?.messages); }
    catch { /* Never escape OMP callbacks. */ }
  });

  pi.on("session_shutdown", (event, ctx) => {
    try {
      const id = rememberContext(event, ctx);
      loops.get(id)?.abort();
      loops.delete(id);
      askPending.delete(id);
      questionIdentityBySession.delete(id);
      approvals.delete(id);
      ctxBySession.delete(id);
      emit("session_end", event, ctx);
    } catch { /* Never escape OMP callbacks. */ }
  });
}

export default install;

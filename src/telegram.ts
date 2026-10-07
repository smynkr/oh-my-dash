import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Card, DashDB, Reply, ResponseDTO, SessionDTO, TelegramQuestionMessage } from "./db.ts";
import type { AskQuestion } from "./normalize.ts";
import type { createReplies } from "./replies.ts";
import { CONTINUE_LABEL, CONTINUE_TEXT } from "./actions.ts";
import { extractRecommendation, LABEL_CP, looksLikeAsk, TITLE_CP, verifiedRecommendation, type Decision, type DecisionSet } from "./decisions.ts";
import { topicFor, type TopicBindings } from "./projects.ts";
import { redact, redactSpan } from "./redact.ts";
import { escapeHtml, formatTelegramContent } from "./telegram-format.ts";
export { redact } from "./redact.ts";

type Mode = "input" | "turns" | "off";
type State = "disabled" | "no_token" | "bad_token" | "webhook_conflict" | "poll_conflict" | "unpaired" | "ok" | "error";
export type Destination = { chatId: string; threadId: number | null; name: string | null };
type SentMessage = { chatId: string; threadId: number | null; messageId: number };
type Outcome = "delivered" | "expired" | "cancelled";
// rec: undefined omits the recommendation line; null shows that none was found on a tracked turn.
type Rec = { verified: boolean; text: string };
type Alert = {
  dto: Pick<SessionDTO, "key" | "displayName" | "host" | "harness" | "sessionKind">;
  reason: string; snippet?: string; turn: boolean; promptId: number; destination: Destination;
  truncated?: boolean;
  resolution?: "Answered" | "Session ended";
  turnSeq?: number; responseId?: number; individual?: boolean; rec?: Rec | null;
  cardId?: number; sent?: string; outcome?: Outcome;
  // R5 decision card: body is the escaped card HTML; status lines append to it.
  decision?: boolean; body?: string;
};
type AlertMessage = { alerts: Alert[]; epoch: number; expiresAt: number; sentAt?: SentMessage; text?: string; part?: number; parts?: number; digest?: boolean };
type QuestionPick = { selected: Set<number>; useCustom: boolean; customInput?: string };
type QuestionCard = {
  id: string; key: string; questions: AskQuestion[]; destination: Destination; picks: QuestionPick[];
  messages: Map<number, { sent: SentMessage; questionIndex: number }>; expiresAt: number; epoch: number; active: boolean;
};
type Update = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallback };
type TelegramMessage = {
  message_id?: number;
  text?: string;
  chat?: { id: number; type?: string; title?: string };
  from?: { id: number; username?: string };
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: { message_id?: number; forum_topic_created?: Record<string, unknown> };
};
type TelegramCallback = { id: string; data?: string; from?: { id: number };
  message?: { message_id?: number; chat?: { id: number; type?: string }; message_thread_id?: number } };
type ApiResponse<T> = { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };

export interface TelegramOptions {
  db: DashDB;
  fetch?: typeof fetch;
  now?: () => number;
  readToken?: () => Promise<string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  apiBase?: string;
  snippetChars?: number;
  reportError?: (area: string, error: unknown) => void;
  replies?: ReturnType<typeof createReplies>;
  topicsEnabled?: boolean;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const exec = promisify(execFile);
const tokenPattern = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const validMode = (value: string | undefined): Mode => value === "turns" || value === "off" ? value : "input";
const reasonLabel = (reason: string, turn = false) => turn ? "Turn finished" : reason === "question" ? "Question" :
  reason === "permission" || reason === "permission_prompt" ? "Permission needed" :
  reason.startsWith("elicitation_") ? "Input requested" : "Waiting for you";
const code = () => [...crypto.getRandomValues(new Uint8Array(8))].map(byte => crockford[byte & 31]).join("");
const shortId = (key: string) => createHash("sha1").update(key).digest("hex").slice(0, 12);
const validTopicName = (name: string) => /^[a-z0-9][a-z0-9/_-]{0,63}$/.test(name);
const validChatId = (value: unknown): value is string => typeof value === "string" && /^-?\d+$/.test(value) &&
  Number.isSafeInteger(Number(value)) && Number(value) !== 0;
const validThreadId = (value: unknown): value is number | null => value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
const isHarness = (dto: SessionDTO) => dto.interactive && ["claude", "omp"].includes(dto.harness);
const cardCode = /^d:([0-9a-z]{1,8}):(0|[1-9]\d?):(0|[1-9]\d?)$/;
const questionCode = /^q:([A-Za-z0-9_-]{8,43}):(0|[1-9]\d?):(c|s|x|0|[1-9]\d?)$/;
const outcomeLine: Record<Outcome, string> = { delivered: "✅ Delivered", expired: "⌛ Expired", cancelled: "✖️ Cancelled" };
const flat = (text: string) => text.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
// A stored title or label at its cap may end inside a token the cap cut, which redact() can no longer recognize;
// display drops that partial token so redaction always sees whole tokens before any display clip.
const uncut = (text: string, cap: number) => [...text].length < cap ? text : `${text.replace(/\s*\S*$/, "")}…`;
const clipped = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  if (limit <= 0) return "";
  let end = limit - 1;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  const boundary = text.slice(0, end).search(/\s+\S*$/u);
  if (boundary >= end * 0.6) end = boundary;
  return `${text.slice(0, end).trimEnd()}…`;
};
// Telegram's 4096 limit counts text after entity parsing, so budgets use the visible length of the HTML.
const visible = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#39);/g, "&").length;
const CARD_GRACE_MS = 60_000;
// R6 owner reply: a pick, else the verified recommendation, else the agent's call. JSON quoting keeps a label inside its clause.
const choiceText = (set: Decision[], picks: Record<string, number>) => `[dash] The owner chose (via Telegram): ${set.map((decision, g) => {
  const pick = picks[g], head = `${g + 1}. ${flat(decision.title)} →`;
  return pick !== undefined ? `${head} ${decision.options[pick]!.key} (${JSON.stringify(flat(decision.options[pick]!.label))}).` :
    decision.recIndex !== null ? `${head} your recommendation (${JSON.stringify(flat(decision.options[decision.recIndex]!.label))}).` : `${head} your call.`;
}).join(" ")}`;
const choiceSummary = (set: Decision[], picks: Record<string, number>) => set.map((decision, g) => `${g + 1}: ${picks[g] !== undefined ?
  decision.options[picks[g]]!.key : decision.recIndex !== null ? `${decision.options[decision.recIndex]!.key}⭐` : "your call"}`).join(", ");
// Option buttons star the recommendation; several decisions also offer Send picks.
const cardKeyboard = (card: Card) => {
  const id = card.id.toString(36), set = card.decisions.decisions, several = set.length > 1;
  const button = (text: string, g: number, o: number) => ({ text, callback_data: `d:${id}:${g}:${o}` });
  return { inline_keyboard: [
    ...set.map((decision, g) => decision.options.map((option, o) => several
      ? button(`${g + 1}: ${option.key}${card.picks?.[g] === o ? "✓" : ""}${decision.recIndex === o ? "⭐" : ""}`, g, o)
      : button(`${clipped(flat(redact(uncut(option.label, LABEL_CP))), 48)}${decision.recIndex === o ? " ⭐" : ""}`, g, o))),
    ...(several ? [[button("✅ Send picks", 99, 0)]] : []),
    [button(CONTINUE_LABEL, 99, 3)],
    [button("📄 Full text", 99, 4), button("🔕 Mute 1h", 99, 5)],
  ] };
};
const optionalInt = (value: Record<string, unknown>, name: string, min: number) => !(name in value) ||
  typeof value[name] === "number" && Number.isSafeInteger(value[name]) && (value[name] as number) >= min;
const validRec = (rec: unknown) => rec === null || !!rec && typeof rec === "object" && "verified" in rec &&
  typeof rec.verified === "boolean" && "text" in rec && typeof rec.text === "string";
function isStoredAlert(value: unknown): value is Alert {
  if (!value || typeof value !== "object" || !("dto" in value) || !("destination" in value)) return false;
  const { dto, destination } = value;
  if (!dto || typeof dto !== "object" || !destination || typeof destination !== "object") return false;
  return "key" in dto && typeof dto.key === "string" && "displayName" in dto && typeof dto.displayName === "string" &&
    "host" in dto && typeof dto.host === "string" && "harness" in dto && (dto.harness === "claude" || dto.harness === "omp") &&
    (!("sessionKind" in dto) || typeof dto.sessionKind === "string") &&
    "reason" in value && typeof value.reason === "string" && "turn" in value && typeof value.turn === "boolean" &&
    "promptId" in value && typeof value.promptId === "number" && Number.isSafeInteger(value.promptId) && value.promptId >= 0 &&
    (!("snippet" in value) || typeof value.snippet === "string") &&
    (!("truncated" in value) || typeof value.truncated === "boolean") &&
    (!("resolution" in value) || value.resolution === "Answered" || value.resolution === "Session ended") &&
    optionalInt(value as Record<string, unknown>, "turnSeq", 0) && optionalInt(value as Record<string, unknown>, "responseId", 1) &&
    optionalInt(value as Record<string, unknown>, "cardId", 1) &&
    (!("individual" in value) || typeof value.individual === "boolean") && (!("rec" in value) || validRec(value.rec)) &&
    (!("sent" in value) || typeof value.sent === "string") && (!("outcome" in value) || typeof value.outcome === "string" && Object.hasOwn(outcomeLine, value.outcome)) &&
    (!("decision" in value) || typeof value.decision === "boolean") && (!("body" in value) || typeof value.body === "string") &&
    "chatId" in destination && validChatId(destination.chatId) && "threadId" in destination && validThreadId(destination.threadId) &&
    "name" in destination && (destination.name === null || typeof destination.name === "string");
}

function apiBase(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return;
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port) return url.origin;
  } catch {}
}

export function createTelegram(opts: TelegramOptions) {
  const db = opts.db, now = opts.now ?? Date.now, fetcher = opts.fetch ?? fetch, replies = opts.replies;
  const topicsEnabled = opts.topicsEnabled ?? process.env.DASH_TG_TOPICS === "1";
  const base = apiBase(opts.apiBase ?? process.env.DASH_TELEGRAM_API_BASE ?? "https://api.telegram.org");
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const service = process.env.DASH_TELEGRAM_KEYCHAIN_SERVICE || "dash-telegram-bot";
  const readToken = opts.readToken ?? (async () => {
    try { return (await exec("/usr/bin/security", ["find-generic-password", "-s", service, "-w"])).stdout; }
    catch { return undefined; }
  });
  const configuredSnippet = opts.snippetChars ?? process.env.DASH_TELEGRAM_SNIPPET_CHARS;
  const rawSnippet = Number(configuredSnippet);
  const snippetChars = configuredSnippet === undefined ? Infinity :
    Number.isFinite(rawSnippet) ? Math.max(0, Math.floor(rawSnippet)) : 400;
  const rawUrgentMinutes = Number(process.env.DASH_TG_URGENT_AFTER_MIN ?? "30");
  const urgentMinutes = Number.isInteger(rawUrgentMinutes) && rawUrgentMinutes >= 1 && rawUrgentMinutes <= 1440 ? rawUrgentMinutes : 30;
  const urgentThresholdMs = urgentMinutes * 60_000;
  let state: State = base ? "no_token" : "disabled";
  let mode = validMode(db.getSetting("telegram.mode"));
  let chatId = db.getSetting("telegram.chat_id"), userId = db.getSetting("telegram.user_id");
  let botUsername: string | null = null, token: string | undefined;
  let badTokenNeedsWait = false;
  let pairEpoch = 0;
  let pairing = code(), pairingExpires = now() + 600_000;
  let sent = 0, dropped = 0, lastSendAt = -Infinity;
  let running = false, draining = false, drainScheduled = false;
  let stopAlertTimer = () => {};
  const abort = new AbortController();
  const last = new Map<string, { status: string; needsReason?: string }>();
  const muted = new Map<string, number>(), ids = new Map<string, string>();
  const statusMaps = new Map<string, { at: number; keys: string[] }>();
  const queue: Alert[] = [];
  let sendingAlerts: Alert[] = [];
  // Cards whose first send is in flight, and cards whose own tap is inside submit() (a synchronous delivery can
  // apply that reply's prompt event before the card is marked sent).
  const sendingCards = new Set<number>(), submittingCards = new Set<number>();
  const alertMessages = new Set<AlertMessage>();
  const questionCards = new Map<string, QuestionCard>();
  const sendingQuestionCards = new Set<string>();
  const editingAlerts = new Set<AlertMessage>();
  for (const saved of db.pendingAlertUpdates(now())) {
    try {
      const content: unknown = JSON.parse(saved.content);
      if (!content || typeof content !== "object" || !("alerts" in content) ||
        !Array.isArray(content.alerts) || !content.alerts.length || !content.alerts.every(isStoredAlert) ||
        !("text" in content) || typeof content.text !== "string") throw new Error("Invalid stored alert");
      const part = "part" in content ? content.part : 0;
      const digest = "digest" in content ? content.digest : content.alerts.length >= 3;
      const parts = "parts" in content ? content.parts : 1;
      if (typeof part !== "number" || !Number.isSafeInteger(part) || part < 0 || typeof digest !== "boolean" ||
        typeof parts !== "number" || !Number.isSafeInteger(parts) || parts < 1 ||
        part >= (digest ? parts : formatTelegramContent(content.alerts[0].snippet ?? "").length)) throw new Error("Invalid stored alert page");
      alertMessages.add({ alerts: content.alerts, text: content.text, part, parts, digest, epoch: pairEpoch, expiresAt: saved.expiresAt,
        sentAt: { chatId: saved.chatId, messageId: saved.messageId, threadId: null } });
    } catch {
      db.setAlertContent(saved.chatId, saved.messageId, null);
      opts.reportError?.("telegram alert restore", new Error("Invalid stored alert content"));
    }
  }
  for (const dto of db.listSessions(true, true)) last.set(dto.key, { status: dto.status, needsReason: dto.needsReason });

  const report = (area: string, error: unknown) => {
    if (!opts.reportError || !running) return;
    const original = error instanceof Error ? error : new Error();
    const safe = new Error();
    safe.name = /^[A-Za-z][A-Za-z0-9]*$/.test(original.name) ? original.name : "Error";
    const rawCode = (original as NodeJS.ErrnoException).code;
    if (rawCode && /^[A-Za-z0-9_]+$/.test(rawCode)) (safe as NodeJS.ErrnoException).code = rawCode;
    opts.reportError(area, safe);
  };
  const wait = async (ms: number) => {
    if (!running || abort.signal.aborted) return;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([sleep(ms), new Promise<void>(resolve => {
        onAbort = resolve;
        abort.signal.addEventListener("abort", onAbort, { once: true });
      })]);
    } finally { if (onAbort) abort.signal.removeEventListener("abort", onAbort); }
  };
  const paired = () => !!chatId && !!userId;
  const dmDestination = (): Destination | null => chatId ? { chatId, threadId: null, name: null } : null;
  const refreshPairing = () => {
    if (!paired() && now() >= pairingExpires) { pairing = code(); pairingExpires = now() + 600_000; }
  };
  const readBindings = (): TopicBindings | null => {
    if (!topicsEnabled) return null;
    const raw = db.getSetting("telegram.topics");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { groupChatId?: unknown; topics?: unknown };
      if (!parsed || !validChatId(parsed.groupChatId) || !parsed.topics || typeof parsed.topics !== "object" || Array.isArray(parsed.topics)) return null;
      if (Object.keys(parsed).some(key => key !== "groupChatId" && key !== "topics")) return null;
      const topics: Record<string, number | null> = {};
      for (const [name, threadId] of Object.entries(parsed.topics as Record<string, unknown>)) {
        if (!validTopicName(name) || !validThreadId(threadId)) return null;
        topics[name] = threadId;
      }
      if (Object.keys(topics).length === 0) return null;
      return { groupChatId: parsed.groupChatId, topics };
    } catch { return null; }
  };
  const destinationForProject = (project: string, bindings = readBindings()): Destination | null => {
    if (!topicsEnabled) return dmDestination();
    const topic = topicFor(project, bindings);
    return topic ? { chatId: topic.chatId, threadId: topic.threadId, name: topic.name } : dmDestination();
  };
  const generalDestination = (bindings = readBindings()): Destination | null => {
    if (!bindings || !Object.hasOwn(bindings.topics, "general")) return null;
    return { chatId: bindings.groupChatId, threadId: bindings.topics.general, name: "general" };
  };
  const sameDestination = (a: Destination, b: Destination) => a.chatId === b.chatId && a.threadId === b.threadId;
  const destinationMode = (destination: Destination, bindings = readBindings()): Mode => {
    if (!topicsEnabled || destination.threadId === null || !destination.name || ["general", "urgent"].includes(destination.name)) return mode;
    const override = db.getSetting(`telegram.mode.${destination.name}`);
    return override === "input" || override === "turns" || override === "off" ? override : mode;
  };
  const incomingDestination = (message: TelegramMessage): Destination => {
    const id = String(message.chat!.id), threadId = message.message_thread_id === 1 ? null : message.message_thread_id ?? null;
    const bindings = readBindings();
    if (!topicsEnabled || !bindings || id !== bindings.groupChatId) return { chatId: id, threadId: null, name: null };
    const name = Object.entries(bindings.topics).find(([, value]) => value === threadId)?.[0] ?? null;
    return { chatId: id, threadId, name };
  };
  const setPaired = (chat: string, user: string, username: string) => {
    db.setSetting("telegram.chat_id", chat); db.setSetting("telegram.user_id", user);
    db.setSetting("telegram.username", username);
    chatId = chat; userId = user; pairing = "";
    pairEpoch++;
    for (const card of [...questionCards.values()]) invalidateQuestionCard(card);
    state = "ok";
    seedUrgentEpisodes();
    replayPendingQuestions();
  };
  const unpair = () => {
    for (const key of ["telegram.chat_id", "telegram.user_id", "telegram.username", "telegram.topics"]) db.deleteSetting(key);
    db.deleteSettingsPrefix("telegram.mode.");
    pairEpoch++;
    for (const card of [...questionCards.values()]) invalidateQuestionCard(card);
    for (const message of db.telegramQuestionMessages()) clearTelegramQuestionMessage(message);
    questionCards.clear();
    chatId = userId = undefined; queue.length = 0; muted.clear(); ids.clear(); statusMaps.clear();
    alertMessages.clear(); db.clearAlertUpdates(); db.expireLiveCards();
    pairing = code(); pairingExpires = now() + 600_000;
    if (token && state !== "webhook_conflict" && state !== "poll_conflict") state = "unpaired";
  };
  const health = () => ({ state, mode, paired: paired(), queued: queue.length, sent, dropped });
  const info = (loopback: boolean) => ({ state, mode, paired: paired(), botUsername, pairingCode: loopback && !paired() && state !== "disabled" ? (refreshPairing(), pairing) : null });

  class ApiError extends Error {
    readonly code: string;
    constructor(readonly status: number, readonly retryAfter = 0, readonly unchanged = false) {
      super(); this.name = "TelegramApiError"; this.code = `TG_HTTP_${status}`;
    }
  }
  const call = async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
    if (!base || !token) throw new ApiError(401);
    const timeout = AbortSignal.timeout(60_000);
    const response = await fetcher(`${base}/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.any([abort.signal, timeout]),
    });
    let payload: ApiResponse<T> | undefined;
    try { payload = await response.json() as ApiResponse<T>; } catch {}
    if (!response.ok || !payload?.ok) throw new ApiError(payload?.error_code ?? response.status ?? 500,
      Number(payload?.parameters?.retry_after ?? 0), payload?.description?.startsWith("Bad Request: message is not modified") === true);
    return payload.result as T;
  };
  const sendText = (destination: Destination, text: string, keyboard?: Record<string, unknown>, replyTo?: number, disableNotification = false) =>
    call<{ message_id: number }>("sendMessage", { chat_id: destination.chatId,
      ...(destination.threadId !== null ? { message_thread_id: destination.threadId } : {}),
      text, parse_mode: "HTML", disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}), ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      ...(disableNotification ? { disable_notification: true } : {}) });
  const validRecipient = (destination: Destination, epoch: number) => running && paired() && epoch === pairEpoch && !!destination.chatId;
  const sendAtDestination = async (destination: Destination, epoch: number, text: string, keyboard?: Record<string, unknown>, replyTo?: number,
    editId?: number, disableNotification = false, canSend?: () => boolean): Promise<SentMessage | undefined> => {
    for (let attempt = 0; attempt <= 3 && validRecipient(destination, epoch) && (!canSend || canSend()); attempt++) {
      const delay = Math.max(0, 1000 - (now() - lastSendAt));
      if (delay) await wait(delay);
      if (!validRecipient(destination, epoch) || canSend && !canSend()) return;
      lastSendAt = now();
      try {
        const message = editId
          ? await call<{ message_id?: number }>("editMessageText", { chat_id: destination.chatId, message_id: editId, text, parse_mode: "HTML",
            disable_web_page_preview: true, ...(keyboard ? { reply_markup: keyboard } : {}) })
          : await sendText(destination, text, keyboard, replyTo, disableNotification);
        sent++;
        return { chatId: destination.chatId, threadId: destination.threadId, messageId: message.message_id ?? editId! };
      } catch (error) {
        const status = error instanceof ApiError ? error.status : undefined;
        if (editId && error instanceof ApiError && error.unchanged) {
          return { chatId: destination.chatId, threadId: destination.threadId, messageId: editId };
        }
        if (editId && (status === 400 || status === 403)) throw error;
        if (status === 401 || status === 404) {
          state = "bad_token"; token = undefined; badTokenNeedsWait = true; report("telegram send", error); return;
        }
        if (topicsEnabled && (status === 400 || status === 403)) {
          report("telegram send", error); return;
        }
        if (attempt === 3) { report("telegram send", error); return; }
        const retry = error instanceof ApiError && status === 429 ? error.retryAfter * 1000 : Math.min(60_000, 2_000 * 2 ** attempt);
        await wait(Math.max(1000, retry));
      }
    }
  };
  const sendWithFallback = async (destination: Destination | null, epoch: number, text: string, keyboard?: Record<string, unknown>, replyTo?: number,
    disableNotification = false, canSend?: () => boolean): Promise<SentMessage | undefined> => {
    if (!destination || !validRecipient(destination, epoch) || canSend && !canSend()) return;
    const sentAt = await sendAtDestination(destination, epoch, text, keyboard, replyTo, undefined, disableNotification, canSend);
    if (sentAt) return sentAt;
    if (!running || epoch !== pairEpoch) return;
    if (!topicsEnabled || !token || destination.chatId === chatId) { dropped++; return; }
    const bindings = readBindings(), general = generalDestination(bindings), dm = dmDestination();
    const candidates = [general, dm].filter((candidate): candidate is Destination => !!candidate);
    for (const candidate of candidates) {
      if (sameDestination(candidate, destination)) continue;
      const changed = !sameDestination(candidate, destination);
      const delivered = await sendAtDestination(candidate, epoch, text, keyboard, changed ? undefined : replyTo, undefined, disableNotification, canSend);
      if (delivered) return delivered;
      if (!token || !running || epoch !== pairEpoch) break;
    }
    dropped++;
  };
  let sendChain: Promise<unknown> = Promise.resolve();
  const queueSend = (destination: Destination | null, text: string, keyboard?: Record<string, unknown>, replyTo?: number,
    disableNotification = false, canSend?: () => boolean): Promise<SentMessage | undefined> => {
    const epoch = pairEpoch;
    const next = sendChain.then(() => !canSend || canSend()
      ? sendWithFallback(destination, epoch, text, keyboard, replyTo, disableNotification, canSend) : undefined);
    sendChain = next.catch(error => report("telegram send", error));
    return next;
  };
  const retrySend = (text: string, keyboard?: Record<string, unknown>, replyTo?: number): Promise<SentMessage | undefined> =>
    queueSend(dmDestination(), text, keyboard, replyTo);
  const retrySendAt = (destination: Destination, text: string, keyboard?: Record<string, unknown>, replyTo?: number): Promise<SentMessage | undefined> =>
    queueSend(destination, text, keyboard, replyTo);
  const editText = (destination: Destination, messageId: number, html: string) => {
    const epoch = pairEpoch;
    const next = sendChain.then(async () => {
      const result = await sendAtDestination(destination, epoch, html, undefined, undefined, messageId);
      if (!result && running && epoch === pairEpoch) dropped++;
      return result;
    });
    sendChain = next.catch(error => report("telegram send", error));
    return next;
  };
  const snippet = (text: string | undefined): Pick<Alert, "snippet" | "truncated"> => {
    if (!snippetChars || !text) return {};
    const clean = redact(text);
    return { snippet: clipped(clean, snippetChars), truncated: clean.length > snippetChars };
  };
  // A3: shrink the quote until the whole page fits Telegram's 4096-character limit. Pages hold at most 3000 visible
  // characters, so the visible budget always leaves room for the line on the last page.
  const recLine = (alert: Alert, budget: number) => {
    if (alert.rec === undefined || alert.rec === null && !alert.cardId) return "";
    if (!alert.rec) return "\n\n<i>No recommendation found in the response.</i>";
    const prefix = alert.rec.verified ? "\n\n⭐ <b>Recommended:</b> " : "\n\n⭐ <b>Recommended</b> (agent's words): ";
    for (let limit = 400; limit > 0; limit = Math.floor(limit * 0.8)) {
      const line = prefix + escapeHtml(clipped(alert.rec.text, limit));
      if (visible(line) <= budget) return line;
    }
    return "";
  };
  // R5 literal card body. Every field is redacted, capped and escaped; labels and titles shrink until the
  // body leaves room for a status line, and only whole lines are ever dropped, so no tag or entity is cut.
  const cardBody = (dto: SessionDTO, set: DecisionSet, rec: Rec | null) => {
    const field = (text: string, cap: number) => escapeHtml(clipped(redact(text), cap));
    const head = [`❓ <b>${field(dto.displayName, 80)}</b> · ${field(dto.host, 80)} · ${escapeHtml(dto.harness)}`,
      `<i>Decision · ${field(dto.project || "unknown", 60)}</i>`];
    let lines: string[] = [];
    for (const scale of [1, 0.6, 0.35, 0.2, 0.1]) {
      const cap = (limit: number) => Math.max(4, Math.floor(limit * scale));
      lines = [...head, !rec ? "<i>No recommendation found in the response.</i>" :
        `⭐ <b>Recommended${rec.verified ? ":</b>" : "</b> (agent's words):"} ${escapeHtml(clipped(rec.text, cap(400)))}`];
      set.decisions.forEach((decision, g) => lines.push(`${g + 1}. <b>${field(uncut(decision.title, TITLE_CP), cap(120))}</b>`,
        ...decision.options.map((option, o) => `   ${field(option.key, 8)} · ${field(uncut(option.label, LABEL_CP), cap(60))}${decision.recIndex === o ? " ⭐" : ""}`)));
      if (lines.join("\n").length <= 3800) break;
    }
    while (lines.join("\n").length > 3800) lines.pop();
    return lines.join("\n");
  };
  const format = (alert: Alert, part = 0) => {
    if (alert.decision && alert.body !== undefined) {
      const status = alert.outcome ? outcomeLine[alert.outcome] : alert.sent ? `✅ Sent: ${escapeHtml(alert.sent)}` :
        alert.resolution ? `✅ ${alert.resolution}` : "";
      return status ? `${alert.body}\n\n${status}` : alert.body;
    }
    const { dto, reason, turn } = alert;
    const name = escapeHtml(clipped(dto.displayName, 256));
    const host = escapeHtml(clipped(dto.host, 256));
    const label = alert.resolution ?? reasonLabel(reason, turn);
    const head = `${alert.resolution || turn ? "✅" : "❓"} <b>${label}</b>\n<b>${name}</b>\nHost: ${host} · Harness: ${escapeHtml(dto.harness)}${dto.sessionKind === "bg" ? " · Background" : ""}`;
    const pages = formatTelegramContent(alert.snippet ?? "");
    const bodyLabel = turn ? "Response" : reason === "question" ? "Question" : "Details";
    const body = alert.snippet ? `\n\n<b>${bodyLabel}${pages.length > 1 ? ` · Part ${part + 1}/${pages.length}` : ""}</b>\n${pages[part]}` : "";
    const excerpt = alert.truncated && part === pages.length - 1
      ? "\n\n<i>Excerpt limited by DASH_TELEGRAM_SNIPPET_CHARS. Full captured text is in dash.</i>" : "";
    const terminalOnly = !turn && (dto.harness === "claude" && reason !== "waiting" || dto.harness === "omp" && reason === "permission");
    const next = alert.resolution || part < pages.length - 1 ? "" :
      `\n\n<b>Next:</b> ${replies && !terminalOnly ? "Reply to this message to continue." : "Open the session in your terminal to continue."}`;
    if (part < pages.length - 1) return `${head}${body}${excerpt}${next}`;
    const status = alert.outcome ? `\n\n${outcomeLine[alert.outcome]}` : alert.sent ? `\n\n✅ Sent: ${escapeHtml(alert.sent)}` : "";
    const before = `${head}${body}${excerpt}`, after = `${next}${status}`;
    return `${before}${recLine(alert, 4096 - visible(before) - visible(after))}${after}`;
  };
  const rememberId = (id: string, key: string) => {
    if (ids.has(id)) ids.delete(id);
    else if (ids.size >= 500) ids.delete(ids.keys().next().value!);
    ids.set(id, key);
  };
  const digest = (alerts: Alert[], part = 0, parts = 1) => {
    const needs = alerts.filter(alert => !alert.turn && !alert.resolution).length;
    const turns = alerts.filter(alert => alert.turn && !alert.resolution).length;
    const resolved = alerts.length - needs - turns;
    const summary = resolved ? `${needs} need you · ${turns} finished · ${resolved} resolved` :
      needs && turns ? `${needs} need you · ${turns} finished` :
      turns ? `${turns} sessions finished` : `${needs} sessions need you`;
    const heading = `Session updates${parts > 1 ? ` · Part ${part + 1}/${parts}` : ""}`;
    const next = "/status for session numbers and reply options.";
    const noticeBudget = `\n\nShowing ${alerts.length} of ${alerts.length} sessions; full list in dash.`.length;
    const rowBudget = 4096 - heading.length - summary.length - next.length - 11 - noticeBudget;
    // Restored pre-pagination digests may have far more than ten rows.
    const fieldLimit = Math.min(80, Math.max(16, Math.floor((rowBudget / alerts.length - 30) / 2)));
    const lines: string[] = [];
    let used = 0;
    for (const { dto, reason, turn, resolution } of alerts) {
      const name = clipped(dto.displayName, fieldLimit), host = clipped(dto.host, fieldLimit);
      const label = resolution ?? reasonLabel(reason, turn);
      const length = `${name}\n${label} · Host: ${host}`.length + (lines.length ? 2 : 0);
      if (used + length > rowBudget) break;
      lines.push(`<b>${escapeHtml(name)}</b>\n${label} · Host: ${escapeHtml(host)}`);
      used += length;
    }
    const notice = lines.length < alerts.length
      ? `\n\n<i>Showing ${lines.length} of ${alerts.length} sessions; full list in dash.</i>` : "";
    return `<b>${heading}</b>\n${summary}\n\n${lines.join("\n\n")}${notice}\n\n<b>Next:</b> ${next}`;
  };
  const batches = (alerts: Alert[]): Alert[][] => {
    if (!topicsEnabled) return [alerts];
    const grouped = new Map<string, Alert[]>();
    for (const alert of alerts) {
      const key = `${alert.destination.chatId}:${alert.destination.threadId ?? "general"}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(alert); grouped.set(key, bucket);
    }
    return [...grouped.values()];
  };
  const alertText = (message: AlertMessage) => (message.digest ?? message.alerts.length >= 3)
    ? digest(message.alerts, message.part, message.parts) : format(message.alerts[0], message.part);
  const persistAlert = (message: AlertMessage) => {
    if (message.sentAt) db.setAlertContent(message.sentAt.chatId, message.sentAt.messageId,
      JSON.stringify({ alerts: message.alerts, text: message.text, part: message.part, parts: message.parts, digest: message.digest }));
  };
  const updateAlert = (message: AlertMessage) => {
    if (!message.sentAt || message.epoch !== pairEpoch) return;
    persistAlert(message);
    if (editingAlerts.has(message)) return;
    editingAlerts.add(message);
    let completed = false;
    const next = sendChain.then(async () => {
      if (!alertMessages.has(message) || !message.sentAt || message.epoch !== pairEpoch) return;
      const text = alertText(message);
      if (text !== message.text) {
        // A live decision card keeps its keyboard; editMessageText without reply_markup would drop it.
        const alert = message.alerts[0], live = !message.digest && alert?.decision && alert.cardId && !alert.sent && !alert.outcome && !alert.resolution;
        const result = await sendAtDestination({ ...message.sentAt, name: null }, message.epoch, text,
          live ? liveKeyboard(alert.cardId!) : undefined, undefined, message.sentAt.messageId);
        if (!result) return;
        message.text = text;
      }
      // A Sent status still awaits its reply's outcome, so a resolved message stays editable until that arrives.
      if (text === alertText(message) && message.alerts.every(alert => alert.resolution && (!alert.sent || alert.outcome))) {
        db.setAlertContent(message.sentAt.chatId, message.sentAt.messageId, null);
        alertMessages.delete(message);
      } else persistAlert(message);
      completed = true;
    });
    sendChain = next.catch(error => {
      if (error instanceof ApiError && (error.status === 400 || error.status === 403) && message.sentAt) {
        db.setAlertContent(message.sentAt.chatId, message.sentAt.messageId, null);
        alertMessages.delete(message);
      }
      report("telegram alert update", error);
    }).finally(() => {
      editingAlerts.delete(message);
      if (completed && alertMessages.has(message) && alertText(message) !== message.text) updateAlert(message);
    });
  };
  const sweepAlertUpdates = () => {
    for (const message of alertMessages) {
      if (now() >= message.expiresAt) {
        if (message.sentAt) db.setAlertContent(message.sentAt.chatId, message.sentAt.messageId, null);
        alertMessages.delete(message);
      } else if (message.alerts.some(alert => alert.resolution) && alertText(message) !== message.text) updateAlert(message);
    }
  };
  const resolveAlert = (alert: Alert, dto: SessionDTO, eventKind?: string) => {
    if (alert.dto.key !== dto.key || alert.resolution || eventKind === "error") return false;
    if (dto.status === "ended") alert.resolution = "Session ended";
    else if (alert.turn
      ? eventKind === "prompt" || db.latestPromptEventId(dto.key) > alert.promptId
      : dto.status === "working" || dto.status === "your_turn" && !dto.needsReason) alert.resolution = "Answered";
    else return false;
    return true;
  };
  const resolveAlerts = (dto: SessionDTO, eventKind?: string) => {
    for (const alert of queue) resolveAlert(alert, dto, eventKind);
    for (const message of alertMessages) {
      let changed = false;
      for (const alert of message.alerts) if (resolveAlert(alert, dto, eventKind)) changed = true;
      if (changed) updateAlert(message);
    }
    for (const alert of sendingAlerts) resolveAlert(alert, dto, eventKind);
  };
  const reconcileAlerts = () => {
    for (const message of alertMessages) {
      for (const alert of message.alerts) {
        const dto = db.getSession(alert.dto.key);
        if (dto) resolveAlert(alert, dto);
      }
      if (message.alerts.some(alert => alert.resolution)) updateAlert(message);
    }
  };
  const liveKeyboard = (id: number) => {
    const card = db.getCard(id);
    return card?.state === "active" ? cardKeyboard(card) : undefined;
  };
  // Card edits share the send chain, so edits of one card stay serialized and paced. The keyboard is read
  // when the edit runs, so a later toggle or send is never overwritten by an older snapshot.
  const markup = (card: Card, keyboard: () => unknown[][] | undefined) => {
    if (card.messageId === null) return;
    const epoch = pairEpoch, messageId = card.messageId;
    sendChain = sendChain.then(async () => {
      const rows = keyboard();
      if (!running || epoch !== pairEpoch || !rows) return;
      const delay = Math.max(0, 1000 - (now() - lastSendAt));
      if (delay) await wait(delay);
      lastSendAt = now();
      try { await call("editMessageReplyMarkup", { chat_id: card.chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } }); }
      catch (error) { if (!(error instanceof ApiError && error.unchanged)) report("telegram card", error); }
    });
  };
  const clearKeyboard = (card: Card) => markup(card, () => []);
  // An owner prompt answers the turn another way (terminal, dashboard, text reply), so the turn's pending or active
  // card stops offering taps. A card's own tap is skipped while its submit() runs; once sent it is never touched.
  const staleAnsweredCard = (dto: SessionDTO) => {
    if (!replies || !Number.isSafeInteger(dto.turnSeq)) return;
    const card = db.cardForTurn(dto.key, dto.turnSeq);
    if (!card || submittingCards.has(card.id) || !db.markCardState(card.id, "stale")) return;
    clearKeyboard(card);
  };
  const failStrandedCards = () => {
    try { db.failStrandedCards(now() - CARD_GRACE_MS, [...sendingCards]); } catch (error) { report("telegram card", error); }
  };
  const cardMessage = (card: Card) =>
    [...alertMessages].find(item => !item.digest && item.sentAt?.chatId === card.chatId && item.sentAt.messageId === card.messageId);
  // Status is monotonic: a terminal outcome is final and a late Sent never replaces it.
  const cardStatus = (card: Card, sent?: string, outcome?: Outcome) => {
    const message = cardMessage(card);
    const alert = message?.alerts[0];
    if (!message || !alert || alert.outcome || !outcome && (!sent || alert.sent)) return;
    if (outcome) alert.outcome = outcome; else alert.sent = sent;
    updateAlert(message);
  };
  // A card row tracks the current turn's options and lets a pending extraction upgrade its alert in place.
  // false means the id overflowed, so the alert goes out plain.
  const cardIntent = (alert: Alert, destination: Destination): Card | false | undefined => {
    if (!replies || alert.turnSeq === undefined || alert.responseId === undefined || alert.resolution) return;
    if (db.getSession(alert.dto.key)?.turnSeq !== alert.turnSeq) return;
    const intent = db.createCardIntent(alert.dto.key, alert.responseId, alert.turnSeq, destination, now());
    if (intent === "card_id_overflow") { report("telegram card", Object.assign(new Error(), { code: "card_id_overflow" })); return false; }
    return intent.created ? intent.card : undefined;
  };
  // R5: Luna found decisions after the turn's ordinary alert went out, so that exact message becomes the card.
  const upgradeCard = (card: Card) => {
    const message = cardMessage(card), alert = message?.alerts[0];
    const dto = db.getSession(card.sessionKey), response = db.getResponse(card.responseId);
    if (!message || !alert || alert.decision || alert.sent || alert.outcome || alert.resolution || !dto || !response ||
      !card.decisions.decisions.length) return;
    alert.decision = true;
    alert.body = cardBody(dto, card.decisions, recommendation(response));
    updateAlert(message);
  };
  const sendAlertMessage = async (alerts: Alert[], part = 0, asDigest = false, destination = alerts[0].destination, parts = 1, last = false) => {
    // Each page owns its resolution state so one answered page cannot suppress edits of the others.
    const message: AlertMessage = { alerts: alerts.map(alert => ({ ...alert })), part, parts, digest: asDigest,
      epoch: pairEpoch, expiresAt: now() + 7*86400_000 };
    alertMessages.add(message);
    const single = !asDigest ? message.alerts[0] : undefined;
    const id = single ? shortId(single.dto.key) : undefined;
    if (single && id) rememberId(id, single.dto.key);
    const intent = single && last ? cardIntent(single, destination) : undefined, card = intent || undefined;
    if (single?.decision && !card?.decisions.decisions.length) {
      // A moved or already-carded turn sends no card; an id overflow or a card without decisions sends the plain alert.
      if (intent === undefined) { alertMessages.delete(message); return; }
      single.decision = false;
    }
    if (card) { single!.cardId = card.id; sendingCards.add(card.id); }
    message.text = alertText(message);
    let sentAt: SentMessage | undefined;
    try {
      sentAt = await queueSend(destination, message.text, single?.decision ? cardKeyboard(card!) : id ? { inline_keyboard: [
        [{ text: "Mute this session 1h", callback_data: `ms:${id}` }],
      ] } : undefined);
    } finally { if (card) sendingCards.delete(card.id); }
    if (!sentAt || message.epoch !== pairEpoch) {
      alertMessages.delete(message);
      if (card) db.markCardState(card.id, "failed", ["pending"]);
      return;
    }
    message.sentAt = sentAt;
    // A card that went stale while its send was in flight (the owner answered another way) keeps no live keyboard.
    if (card && !db.activateCard(card.id, sentAt)) clearKeyboard({ ...card, ...sentAt });
    db.rememberAlert(sentAt.chatId, sentAt.messageId, single?.dto.key ?? null, single ? "alert" : "digest", now());
    db.pruneCards(now());
    persistAlert(message);
    if (message.alerts.some(alert => alert.resolution)) updateAlert(message);
    // Luna may have finished while this alert was in flight.
    const live = card && !single!.decision ? db.getCard(card.id) : undefined;
    if (live?.state === "active" && live.decisions.decisions.length) upgradeCard(live);
    return sentAt;
  };
  const sendAlert = async (alerts: Alert[]) => {
    const epoch = pairEpoch;
    let destination = alerts[0].destination;
    // Answerable turn alerts stay individual so later extraction can upgrade the same message.
    const grouped = alerts.filter(alert => !alert.individual);
    const digested = grouped.length >= 3 ? grouped : [];
    if (digested.length) {
      // Ten bounded rows leave room for the summary and every later resolution edit.
      for (let offset = 0; offset < digested.length && epoch === pairEpoch; offset += 10) {
        const sentAt = await sendAlertMessage(digested.slice(offset, offset + 10), offset / 10, true, destination, Math.ceil(digested.length / 10));
        if (!sentAt) break;
        destination = { ...sentAt, name: destination.name };
      }
    }
    for (const alert of alerts) {
      if (digested.includes(alert)) continue;
      const pages = formatTelegramContent(alert.snippet ?? "");
      for (let part = 0; part < pages.length && epoch === pairEpoch; part++) {
        const sentAt = await sendAlertMessage([alert], part, false, destination, 1, part === pages.length - 1);
        if (!sentAt) break;
        destination = { ...sentAt, name: destination.name };
      }
    }
  };
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && running && paired()) {
        sendingAlerts = queue.splice(0);
        for (const bucket of batches(sendingAlerts)) await sendAlert(bucket);
        sendingAlerts = [];
      }
    } catch (error) { report("telegram queue", error); }
    finally { sendingAlerts = []; draining = false; if (queue.length && running && paired()) scheduleDrain(); }
  };
  const scheduleDrain = () => {
    if (drainScheduled || draining || !running) return;
    drainScheduled = true;
    queueMicrotask(() => { drainScheduled = false; void drain(); });
  };

  const statusKey = (chat: string, thread: number | null) => `${chat}:${thread ?? "general"}`;
  const statusKeyAt = (chat: string, thread: number | null, n: number): string | undefined => {
    const snapshot = statusMaps.get(statusKey(chat, thread));
    if (!snapshot || now() - snapshot.at >= 1_800_000) return undefined;
    return snapshot.keys[n - 1];
  };
  const statusText = (destination: Destination) => {
    let sessions = db.listSessions().filter(isHarness);
    const bindings = readBindings();
    if (topicsEnabled && destination.threadId !== null && destination.chatId !== chatId && destination.name && !["general", "urgent"].includes(destination.name)) {
      sessions = sessions.filter(dto => {
        const routed = topicFor(dto.project, bindings);
        return routed?.chatId === destination.chatId && routed.threadId === destination.threadId;
      });
    }
    const needs = sessions.filter(dto => dto.status === "needs_input"), ready = sessions.filter(dto => dto.status === "your_turn");
    const working = sessions.filter(dto => dto.status === "working").length;
    const listed = [...needs, ...ready].slice(0, 15);
    statusMaps.set(statusKey(destination.chatId, destination.threadId), { at: now(), keys: listed.map(dto => dto.key) });
    const lines = listed.map((dto, index) => {
      const age = Math.max(0, Math.floor((now() - dto.lastActivity) / 60_000));
      return `${index + 1}. <b>${escapeHtml(clipped(dto.displayName, 80))}</b>\n${dto.status === "needs_input" ? reasonLabel(dto.needsReason ?? "waiting") : "Your turn"} · Host: ${escapeHtml(clipped(dto.host, 80))} · ${age}m ago`;
    });
    const total = needs.length + ready.length;
    const more = total > listed.length ? `\n\nShowing ${listed.length} of ${total} waiting sessions. Open dash for the full list.` : "";
    return `<b>Session status</b>\n${needs.length} sessions need input · ${ready.length} your turn · ${working} working` +
      (lines.length ? `\n\n${lines.join("\n\n")}${more}\n\n<b>Reply:</b> /r N your text` : "\n\nNo sessions are waiting for you.");
  };

  const replyOutcome = (item: Reply, outcome: Outcome, dto?: SessionDTO, ttlMin = 15) => {
    const card = db.cardForReply(item.id);
    if (card) cardStatus(card, undefined, outcome);
    const current = db.getReply(item.id);
    const msgId = current ? current.tgMsgId : item.tgMsgId;
    const recordedChat = current ? current.tgChatId : item.tgChatId;
    if (!msgId || !recordedChat) return;
    const name = escapeHtml(clipped(dto?.displayName ?? "session", 256));
    const host = escapeHtml(clipped(dto?.host ?? "", 256));
    const html = outcome === "delivered" ? `✅ Delivered to <b>${name}</b> · ${host}` :
      outcome === "expired" ? `⌛ Not delivered to <b>${name}</b>: it wasn't ready within ${ttlMin} min.` :
      dto?.status === "ended" ? `✖️ Not delivered: <b>${name}</b> ended.` : "✖️ Cancelled.";
    void editText({ chatId: recordedChat, threadId: null, name: null }, msgId, html);
  };
  const replyRefusal = (reason: string) => {
    switch (reason) {
      case "disabled": return "Replies are off on the hub.";
      case "invalid_text": case "empty_text": return "Only text replies can be sent to a session.";
      case "session_not_found": return "That session could not be found.";
      case "session_ended": return "That session has ended.";
      case "claude_dialog": return "Claude dialogs can't be answered by a free-text reply. Use AskUserQuestion buttons when available; answer permission prompts in the terminal or Remote Control.";
      case "omp_approval": return "omp tool approvals can't be answered from dash yet.";
      case "stale_turn": return "Out of date: the session has moved on";
      case "not_deliverable": return "That session is not ready for this action.";
      default: return "Could not queue that reply.";
    }
  };
  const routeReply = async (key: string, text: string, destination: Destination, toMessageId?: number) => {
    if (!replies) { await retrySendAt(destination, "Replies are off on the hub."); return; }
    const submitted = replies.submit({ key, text, source: "telegram", actor: `telegram:${userId}`, listener: "telegram" });
    if ("refused" in submitted) { await retrySendAt(destination, replyRefusal(submitted.reason)); return; }
    const dto = db.getSession(key);
    const sentAt = await retrySendAt(destination, `📨 Queued for <b>${escapeHtml(clipped(dto?.displayName ?? "session", 256))}</b> · ${escapeHtml(clipped(dto?.host ?? "", 256))}`, undefined, toMessageId);
    if (!sentAt) return;
    db.setReplyTgMsg(submitted.replyId, sentAt.chatId, sentAt.messageId);
    const current = db.getReply(submitted.replyId);
    if (current && ["delivered", "expired", "cancelled"].includes(current.state)) {
      const latest = db.getSession(key);
      replyOutcome(current, current.state as "delivered" | "expired" | "cancelled",
        current.state === "cancelled" && latest?.status !== "ended" ? undefined : latest ?? dto);
    }
  };
  const questionSelectionReady = (question: AskQuestion, pick: QuestionPick) =>
    question.multi === true || pick.selected.size === 1 || !!pick.useCustom && !!pick.customInput?.trim();
  const questionText = (question: AskQuestion) => [
    ...(question.header ? [`Header: ${question.header}`] : []),
    `Question: ${question.question}`,
    `Select ${question.multi ? "all that apply" : "one option"}:`,
    ...question.options.map((option, index) => {
      const recommended = question.recommended === index && !option.label.endsWith(" (Recommended)");
      return `${index + 1}. ${option.label}${recommended ? " (Recommended)" : ""}` +
        `${option.description ? `\n   ${option.description}` : ""}` +
        `${option.preview ? `\n   Preview: ${option.preview}` : ""}`;
    }),
  ].join("\n\n");
  const questionLabelsVisible = (question: AskQuestion, text: string) => {
    return question.options.every((option, index) => text.includes(`${index + 1}. ${redact(option.label)}`));
  };
  const questionKeyboard = (card: QuestionCard, index: number) => {
    const question = card.questions[index]!, pick = card.picks[index]!;
    const rows: { text: string; callback_data: string }[][] = [];
    for (let option = 0; option < question.options.length; option += 2) {
      rows.push([option, option + 1].filter(value => value < question.options.length).map(value => ({
        text: `${pick.selected.has(value) ? "✓ " : ""}${value + 1}`,
        callback_data: `q:${card.id}:${index}:${value}`,
      })));
    }
    rows.push([{ text: `${pick.useCustom ? "✓ " : ""}✍️ Custom answer`, callback_data: `q:${card.id}:${index}:c` }]);
    if (index === card.questions.length - 1) rows.push([{ text: "✅ Submit answers", callback_data: `q:${card.id}:${index}:s` }]);
    if (db.getSession(card.key)?.harness === "claude")
      rows.push([{ text: "✖ Use terminal instead", callback_data: `q:${card.id}:${index}:x` }]);
    return { inline_keyboard: rows };
  };
  const questionDestination = (message: TelegramQuestionMessage): Destination => {
    const bindings = readBindings(), name = bindings?.groupChatId === message.chatId
      ? Object.entries(bindings.topics).find(([, thread]) => thread === message.threadId)?.[0] ?? null : null;
    return { chatId: message.chatId, threadId: message.threadId, name };
  };
  const questionCardFor = (id: string, key: string, row?: TelegramQuestionMessage): QuestionCard | undefined => {
    const dto = db.getSession(key), existing = questionCards.get(id);
    if (!dto || !isHarness(dto) || dto.status !== "needs_input" || dto.needsReason !== "question" ||
        (dto.pendingQuestion?.id ?? dto.pendingQuestionId) !== id || !dto.pendingQuestion?.questions?.length) return undefined;
    const invocation = dto.harness === "claude" ? db.getQuestionInvocation(id, key) : undefined;
    if (dto.harness === "claude" && (!invocation || invocation.state !== "pending" || invocation.expiresAt <= now())) return undefined;
    if (existing && existing.key === key && existing.epoch === pairEpoch && existing.active) return existing;
    const messages = new Map<number, { sent: SentMessage; questionIndex: number }>();
    for (const saved of db.telegramQuestionMessagesForQuestion(id)) {
      if (saved.sessionKey !== key || saved.prompt) continue;
      messages.set(saved.questionIndex, { sent: { chatId: saved.chatId, threadId: saved.threadId, messageId: saved.messageId },
        questionIndex: saved.questionIndex });
    }
    const destination = row ? questionDestination(row) : destinationForProject(dto.project) ?? dmDestination();
    if (!destination) return undefined;
    const card: QuestionCard = {
      id, key, questions: dto.pendingQuestion.questions, destination,
      picks: dto.pendingQuestion.questions.map(() => ({ selected: new Set(), useCustom: false })),
      messages, expiresAt: invocation?.expiresAt ?? now() + 7 * 86400_000, epoch: pairEpoch, active: true,
    };
    if (existing) existing.active = false;
    questionCards.set(id, card);
    return card;
  };
  const questionCardLive = (card: QuestionCard) => {
    if (!card.active || card.epoch !== pairEpoch || card.expiresAt <= now() || !paired()) return false;
    const dto = db.getSession(card.key);
    if (!dto || !isHarness(dto) || dto.status !== "needs_input" || dto.needsReason !== "question" ||
        (dto.pendingQuestion?.id ?? dto.pendingQuestionId) !== card.id) return false;
    if (dto.harness === "claude") {
      const invocation = db.getQuestionInvocation(card.id, card.key);
      return !!invocation && invocation.state === "pending" && invocation.expiresAt > now();
    }
    return dto.harness === "omp";
  };
  const clearTelegramQuestionMessage = (message: TelegramQuestionMessage) => {
    db.deleteTelegramQuestionMessage(message.chatId, message.messageId);
    const next = sendChain.then(async () => {
      if (!token || !base) return;
      const delay = Math.max(0, 1000 - (now() - lastSendAt));
      if (delay) await wait(delay);
      if (!token || !base) return;
      lastSendAt = now();
      await call(message.prompt ? "deleteMessage" : "editMessageReplyMarkup", message.prompt
        ? { chat_id: message.chatId, message_id: message.messageId }
        : { chat_id: message.chatId, message_id: message.messageId, reply_markup: { inline_keyboard: [] } });
    });
    sendChain = next.catch(error => report("telegram question cleanup", error));
    void next.catch(() => {});
  };
  const invalidateQuestionCard = (card: QuestionCard) => {
    card.active = false;
    if (questionCards.get(card.id) === card) questionCards.delete(card.id);
    for (const message of db.telegramQuestionMessagesForQuestion(card.id)) clearTelegramQuestionMessage(message);
    card.messages.clear();
  };
  const buildQuestionPage = (card: QuestionCard, index: number, part: number, parts: number, chunk: string) =>
    `<b>${card.questions.length > 1 ? `Question ${index + 1}/${card.questions.length}` : "Claude / OMP question"}` +
    `${parts > 1 ? ` · Part ${part + 1}/${parts}` : ""}</b>\n<pre>${escapeHtml(chunk)}</pre>`;
  const invalidateQuestionId = (id: string) => {
    const card = questionCards.get(id);
    if (card) { invalidateQuestionCard(card); return; }
    for (const message of db.telegramQuestionMessagesForQuestion(id)) clearTelegramQuestionMessage(message);
  };
  const sendQuestionCard = async (card: QuestionCard) => {
    if (sendingQuestionCards.has(card.id)) return;
    sendingQuestionCards.add(card.id);
    try {
      const canSend = () => questionCardCanSend(card);
      if (!canSend()) { invalidateQuestionCard(card); return; }
      const texts = card.questions.map(question => clipped(redact(questionText(question)), snippetChars));
      if (texts.some((text, index) => !questionLabelsVisible(card.questions[index]!, text))) {
        invalidateQuestionCard(card); return;
      }
      for (let index = 0; index < card.questions.length && canSend(); index++) {
        if (card.messages.has(index)) continue;
        const points = [...texts[index]!], chunks: string[] = [];
        for (let offset = 0; offset < points.length; offset += 600) chunks.push(points.slice(offset, offset + 600).join(""));
        let finalMessage: SentMessage | undefined;
        for (let part = 0; part < chunks.length && canSend(); part++) {
          const lastPage = part === chunks.length - 1;
          finalMessage = await queueSend(card.destination, buildQuestionPage(card, index, part, chunks.length, chunks[part]!),
            lastPage ? questionKeyboard(card, index) : undefined, undefined, false, canSend);
          if (!finalMessage) { invalidateQuestionCard(card); return; }
        }
        if (!finalMessage) { invalidateQuestionCard(card); return; }
        const saved: TelegramQuestionMessage = {
          questionId: card.id, sessionKey: card.key, chatId: finalMessage.chatId, threadId: finalMessage.threadId,
          messageId: finalMessage.messageId, questionIndex: index, createdAt: now(), prompt: false,
        };
        if (!canSend()) { clearTelegramQuestionMessage(saved); invalidateQuestionCard(card); return; }
        db.rememberTelegramQuestionMessage(saved);
        card.messages.set(index, { sent: finalMessage, questionIndex: index });
      }
    } finally { sendingQuestionCards.delete(card.id); }
  };
  const createQuestionCard = (dto: SessionDTO) => {
    if (!replies || !isHarness(dto) || dto.status !== "needs_input" || dto.needsReason !== "question" ||
        !dto.pendingQuestion?.questions?.length || snippetChars === 0 || isMuted(dto.key)) return;
    const id = dto.pendingQuestion.id;
    if (!/^[A-Za-z0-9_-]{8,43}$/.test(id)) return;
    const destination = destinationForProject(dto.project);
    if (!destination || destinationMode(destination) === "off" || !paired() ||
        ["disabled", "webhook_conflict", "poll_conflict"].includes(state)) return;
    const card = questionCardFor(id, dto.key);
    if (card) void sendQuestionCard(card);
  };
  const replayPendingQuestions = () => {
    for (const dto of db.listSessions(true, true)) createQuestionCard(dto);
  };
  const restoreQuestionCards = () => {
    for (const message of db.telegramQuestionMessages()) {
      if (message.prompt) { clearTelegramQuestionMessage(message); continue; }
      const dto = db.getSession(message.sessionKey), card = dto && questionCardFor(message.questionId, message.sessionKey, message);
      if (!card) { clearTelegramQuestionMessage(message); continue; }
      updateQuestionKeyboard(card, message.questionIndex);
    }
    replayPendingQuestions();
  };
  const submitQuestionCard = (card: QuestionCard) => {
    if (!replies || !questionCardLive(card)) return { refused: true as const, reason: "stale_question" };
    if (!card.questions.every((question, index) => questionSelectionReady(question, card.picks[index]!)))
      return { refused: true as const, reason: "invalid_question" };
    if (db.getSession(card.key)?.harness === "claude") {
      const selections = Object.create(null) as Record<string, { selectedOptions: number[]; customInput?: string }>;
      card.questions.forEach((question, index) => {
        const pick = card.picks[index]!;
        selections[question.question] = {
          selectedOptions: [...pick.selected].sort((left, right) => left - right),
          ...(pick.useCustom && pick.customInput?.trim() ? { customInput: pick.customInput } : {}),
        };
      });
      return replies.submitQuestion({ key: card.key, questionId: card.id, answers: selections,
        source: "telegram", actor: `telegram:${userId}`, listener: "telegram" });
    }
    const text = card.questions.map((question, index) => {
      const pick = card.picks[index]!;
      const result = {
        selectedOptions: question.options.filter((_, option) => pick.selected.has(option)).map(option => option.label),
        ...(pick.useCustom && pick.customInput?.trim() ? { customInput: pick.customInput } : {}),
      };
      return `${JSON.stringify(question.id)}: ${JSON.stringify(result)}`;
    }).join("\n");
    if ([...text].length > 4000) return { refused: true as const, reason: "invalid_question" };
    return replies.submit({ key: card.key, text, source: "telegram", actor: `telegram:${userId}`,
      listener: "telegram", answersQuestion: card.id });
  };
  const questionRefusal = (reason: string) => reason === "disabled" ? "Replies are off on the hub." :
    reason === "invalid_question" ? "Choose an answer for every question, then submit." :
      "This question has expired or was replaced.";
  const requestCustomQuestionAnswer = async (card: QuestionCard, index: number) => {
    if (!questionCardLive(card)) return;
    const questionMessage = card.messages.get(index)?.sent;
    if (!questionMessage) return;
    const destination = { chatId: questionMessage.chatId, threadId: questionMessage.threadId, name: null };
    const sentAt = await queueSend(destination, `Reply with your custom answer for question ${index + 1}.`,
      { force_reply: true, selective: true }, questionMessage.messageId);
    if (!sentAt || !questionCardLive(card)) return;
    const saved: TelegramQuestionMessage = {
      questionId: card.id, sessionKey: card.key, chatId: sentAt.chatId, threadId: sentAt.threadId,
      messageId: sentAt.messageId, questionIndex: index, createdAt: now(), prompt: true,
    };
    db.rememberTelegramQuestionMessage(saved);
  };
  const handleCustomQuestionReply = async (message: TelegramMessage, record: TelegramQuestionMessage, text: string) => {
    const destination = incomingDestination(message), card = questionCardFor(record.questionId, record.sessionKey, record);
    if (!card || !questionCardLive(card) || !sameDestination(questionDestination(record), destination)) {
      invalidateQuestionId(record.questionId);
      await retrySendAt(destination, "That question is no longer accepting answers.");
      return true;
    }
    const pick = card.picks[record.questionIndex];
    if (!pick || !pick.useCustom || !text.trim() || [...text].length > 4000 ||
        /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
      await retrySendAt(destination, "Enter a non-empty custom answer of at most 4,000 characters.", undefined, message.message_id);
      return true;
    }
    pick.customInput = text;
    clearTelegramQuestionMessage(record);
    void updateQuestionKeyboard(card, record.questionIndex);
    await retrySendAt(destination, "Custom answer captured.", undefined, message.message_id);
    return true;
  };
  const updateQuestionKeyboard = (card: QuestionCard, index: number) => {
    const message = card.messages.get(index)?.sent;
    if (!message) return;
    const next = sendChain.then(async () => {
      if (!questionCardLive(card)) return;
      const delay = Math.max(0, 1000 - (now() - lastSendAt));
      if (delay) await wait(delay);
      if (!questionCardLive(card)) return;
      lastSendAt = now();
      await call("editMessageReplyMarkup", { chat_id: message.chatId, message_id: message.messageId, reply_markup: questionKeyboard(card, index) });
    });
    sendChain = next.catch(error => report("telegram question keyboard", error));
    void next.catch(() => {});
  };
  const handleQuestionCallback = async (callback: TelegramCallback, chatId: string, data: string) => {
    const match = questionCode.exec(data), messageId = callback.message?.message_id;
    if (!match || messageId === undefined) { await answerCallback(callback, "Expired"); return; }
    const id = match[1]!, index = Number(match[2]), action = match[3]!;
    const record = db.telegramQuestionMessage(chatId, messageId);
    const callbackThread = callback.message?.message_thread_id === 1 ? null : callback.message?.message_thread_id ?? null;
    if (!record || record.prompt || record.questionId !== id || record.questionIndex !== index || record.threadId !== callbackThread) {
      await answerCallback(callback, "Expired"); return;
    }
    const card = questionCardFor(id, record.sessionKey, record);
    if (!card || !questionCardLive(card) || !card.messages.has(index)) {
      invalidateQuestionId(id);
      await answerCallback(callback, "Out of date: the session has moved on"); return;
    }
    const question = card.questions[index]!, pick = card.picks[index]!;
    if (action === "x") {
      const invocation = db.getQuestionInvocation(id, card.key);
      if (!invocation || dtoHarness(card) !== "claude" || !replies?.cancelQuestion(id, card.key, invocation.toolUseId)) {
        invalidateQuestionCard(card); await answerCallback(callback, "This question has expired or was replaced."); return;
      }
      invalidateQuestionCard(card);
      await answerCallback(callback, "Use the native terminal question.");
      return;
    }
    if (action === "c") {
      pick.useCustom = true;
      if (question.multi !== true) pick.selected.clear();
      void updateQuestionKeyboard(card, index);
      await answerCallback(callback, "Reply with your custom answer.");
      await requestCustomQuestionAnswer(card, index);
      return;
    }
    if (action === "s") {
      if (index !== card.questions.length - 1) { await answerCallback(callback, "Submit from the last question."); return; }
      const submitted = submitQuestionCard(card);
      if ("refused" in submitted) {
        if (submitted.reason === "stale_question") invalidateQuestionCard(card);
        await answerCallback(callback, questionRefusal(submitted.reason));
        return;
      }
      const harness = dtoHarness(card);
      invalidateQuestionCard(card);
      await answerCallback(callback, harness === "claude" ? "Answers sent to Claude." : "Answers sent to OMP.");
      return;
    }
    const option = Number(action);
    if (!Number.isSafeInteger(option) || option < 0 || option >= question.options.length) {
      await answerCallback(callback, "Expired"); return;
    }
    if (question.multi === true) {
      if (pick.selected.has(option)) pick.selected.delete(option); else pick.selected.add(option);
    } else {
      pick.selected.clear(); pick.selected.add(option); pick.useCustom = false; pick.customInput = undefined;
    }
    void updateQuestionKeyboard(card, index);
    await answerCallback(callback, `${pick.selected.has(option) ? "Selected" : "Cleared"} option ${option + 1}.`);
  };
  const dtoHarness = (card: QuestionCard) => db.getSession(card.key)?.harness;

  const sendUrgent = async (project: string, body: string): Promise<boolean> => {
    if (!topicsEnabled || !running || !paired() || ["disabled", "webhook_conflict", "poll_conflict"].includes(state)) return false;
    const bindings = readBindings();
    const urgentThread = bindings && Object.hasOwn(bindings.topics, "urgent")
      ? { chatId: bindings.groupChatId, threadId: bindings.topics.urgent, name: "urgent" } satisfies Destination
      : dmDestination();
    if (!urgentThread) return false;
    const mutedUntil = Number(db.getSetting("telegram.mute_until") ?? 0) > now();
    const silent = mutedUntil || destinationMode(urgentThread, bindings) === "off";
    const pages = formatTelegramContent(redact(body));
    const projectLabel = escapeHtml(clipped(redact(project || "unknown"), 256));
    const epoch = pairEpoch;
    let destination = urgentThread;
    for (let part = 0; part < pages.length; part++) {
      if (epoch !== pairEpoch) return false;
      const text = `⚠️ <b>Urgent${pages.length > 1 ? ` · Part ${part + 1}/${pages.length}` : ""}</b>\nProject: <b>${projectLabel}</b>\n\n${pages[part]}`;
      const sentAt = await queueSend(destination, text, undefined, undefined, silent);
      if (!sentAt) return false;
      destination = { ...sentAt, name: destination.name };
    }
    return true;
  };
  const seedUrgentEpisodes = () => {
    if (!topicsEnabled || !paired()) return;
    for (const dto of db.listSessions(true, true)) {
      if (dto.status !== "needs_input" || !isHarness(dto)) continue;
      if (db.isConfirmedMissingSession(dto.key)) { db.endUrgentEpisode(dto.key); continue; }
      if (!db.hasUrgentEpisode(dto.key)) db.startUrgentEpisode(dto.key, dto.lastActivity);
    }
  };
  const sweepUrgentEpisodes = () => {
    if (!topicsEnabled || !paired()) return;
    for (const episode of db.dueUrgentEpisodes(now(), urgentThresholdMs)) {
      const dto = db.getSession(episode.sessionKey);
      if (!dto || dto.status !== "needs_input" || !isHarness(dto) || db.isConfirmedMissingSession(episode.sessionKey)) {
        db.endUrgentEpisode(episode.sessionKey); continue;
      }
      if (!db.markUrgentRepaged(episode.sessionKey, now())) continue;
      void sendUrgent(dto.project, `Still needs input: ${dto.displayName} · ${dto.host}`);
    }
  };
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => { const id = setInterval(fn, ms); return () => clearInterval(id); });

  // The current turn's stored hook response, read in full rather than from the clipped snippet.
  const currentResponse = (dto: SessionDTO, eventKind?: string): ResponseDTO | undefined => {
    if (!replies || eventKind !== "response" || dto.status !== "your_turn" || !Number.isSafeInteger(dto.turnSeq)) return;
    const response = db.responseForTurn(dto.key, dto.turnSeq);
    return response?.source === "hook" ? response : undefined;
  };
  // Redact a window past the span so a secret cut by the quote cap is still masked.
  const recommendation = (response: ResponseDTO): Rec | null => {
    const verified = (response.decisions?.decisions ?? []).filter(decision => verifiedRecommendation(decision, response.text));
    if (verified.length) return { verified: true, text: redact(verified.map(({ title, options, recIndex }) =>
      `${uncut(title, TITLE_CP)} → ${options[recIndex!].key} (${uncut(options[recIndex!].label, LABEL_CP)})`).join("; ")) };
    const found = extractRecommendation(response.text);
    return found ? { verified: false, text: redactSpan(response.text, found.start, found.end) } : null;
  };
  // Claude AskUserQuestion options carry their own "(Recommended)" marker; without one the line is omitted.
  const questionRecommendation = (dto: SessionDTO): Rec | undefined => {
    if (!replies || !snippetChars || dto.harness !== "claude" || dto.needsReason !== "question") return;
    try {
      const questions: unknown = JSON.parse(db.latestQuestionDetail(dto.key) ?? "[]");
      const labels = (Array.isArray(questions) ? questions : []).flatMap(options => Array.isArray(options) ? options : [])
        .map(option => option && typeof option === "object" ? (option as { label?: unknown }).label : undefined)
        .filter((label): label is string => typeof label === "string" && /\(recommended\)/i.test(label));
      return labels.length ? { verified: false, text: redact(labels.join("; ")) } : undefined;
    } catch { return undefined; }
  };
  const isMuted = (key: string) => Number(db.getSetting("telegram.mute_until") ?? 0) > now() || (muted.get(key) ?? 0) > now();
  const questionCardCanSend = (card: QuestionCard) => questionCardLive(card) && !isMuted(card.key);
  const cardAlert = (dto: SessionDTO, response: ResponseDTO, destination: Destination): Alert => {
    const { key, displayName, host, harness, sessionKind } = dto, rec = recommendation(response);
    return { dto: { key, displayName, host, harness, sessionKind }, reason: "waiting", turn: true, promptId: db.latestPromptEventId(key),
      destination, turnSeq: dto.turnSeq, responseId: response.id, individual: true, rec, decision: true, body: cardBody(dto, response.decisions!, rec) };
  };
  const observe = (dto: SessionDTO, eventKind?: string) => {
    try {
      const previous = last.get(dto.key);
      last.set(dto.key, { status: dto.status, needsReason: dto.needsReason });
      for (const card of questionCards.values())
        if (card.key === dto.key && !questionCardLive(card)) invalidateQuestionCard(card);
      if (dto.status === "needs_input" && dto.needsReason === "question") createQuestionCard(dto);
      resolveAlerts(dto, eventKind);
      if (eventKind === "prompt") staleAnsweredCard(dto);
      if (topicsEnabled) {
        if (dto.status === "needs_input" && isHarness(dto)) {
          if (db.isConfirmedMissingSession(dto.key)) db.endUrgentEpisode(dto.key);
          else if (previous?.status !== "needs_input" && !db.hasUrgentEpisode(dto.key)) db.startUrgentEpisode(dto.key, dto.lastActivity);
        } else if (previous?.status === "needs_input" || dto.status === "needs_input" || dto.status === "ended") db.endUrgentEpisode(dto.key);
      }
      if (topicsEnabled && eventKind === "error") {
        void sendUrgent(dto.project, `Session error: ${dto.displayName} · ${dto.host}`);
        return;
      }
      if (!isHarness(dto)) return;
      const destination = destinationForProject(dto.project);
      if (!destination) return;
      const currentMode = destinationMode(destination);
      const response = currentResponse(dto, eventKind), decided = !!response?.decisions?.decisions.length;
      // A2: input mode now alerts on a your_turn response that asks something; turns mode keeps its trigger.
      // R5: a response with decisions sends its card at once in either mode, in place of the ordinary alert.
      const answerable = !!response && (decided ||
        (currentMode === "turns" ? previous?.status === "working" : currentMode === "input" && looksLikeAsk(response.text)));
      const turn = answerable || currentMode === "turns" && previous?.status === "working" && dto.status === "your_turn";
      const needs = dto.status === "needs_input" && (previous?.status !== "needs_input" || previous.needsReason !== dto.needsReason);
      if ((!turn && !needs) || currentMode === "off" || !paired() || ["disabled", "webhook_conflict", "poll_conflict"].includes(state)) return;
      if (isMuted(dto.key)) return;
      if (needs && dto.needsReason === "waiting" && replies && Number.isSafeInteger(dto.turnSeq)) {
        const card = db.cardForTurn(dto.key, dto.turnSeq);
        if (card && (card.state === "pending" || card.state === "active")) return;
      }
      if (decided) { queue.push(cardAlert(dto, response!, destination)); scheduleDrain(); return; }
      const { key, displayName, host, harness, sessionKind } = dto;
      const rec = answerable ? recommendation(response!) : needs ? questionRecommendation(dto) : undefined;
      queue.push({ dto: { key, displayName, host, harness, sessionKind }, reason: dto.needsReason ?? "waiting", turn,
        promptId: turn ? db.latestPromptEventId(key) : 0, ...snippet(turn ? response?.text ?? dto.lastResponses[0]?.text : dto.needsText), destination,
        ...(answerable ? { turnSeq: dto.turnSeq, responseId: response!.id, individual: true } : {}), ...(rec !== undefined ? { rec } : {}) });
      scheduleDrain();
    } catch (error) { report("telegram observe", error); }
  };

  // R5: Luna settled a current-turn response. A live turn alert is edited into the card; with no alert for the
  // turn a new card goes out. None or failed leaves the ordinary alert as it is. Never edits a digest.
  const observeDecisions = (dto: SessionDTO, responseId: number) => {
    try {
      const response = db.getResponse(responseId);
      if (!replies || !isHarness(dto) || dto.status !== "your_turn" || !response?.decisions?.decisions.length ||
        response.source !== "hook" || response.turnSeq !== dto.turnSeq) return;
      // An active card upgrades now even mid-batch; a pending one is in flight and upgrades itself once sent.
      // A failed card never reached the owner, so the turn gets a new one.
      const card = db.cardForTurn(dto.key, dto.turnSeq);
      if (card && card.state !== "failed") { if (card.state === "active") upgradeCard(card); return; }
      // A queued alert for this turn gets its card row when it is sent, then upgrades itself.
      if ([...queue, ...sendingAlerts].some(alert => alert.dto.key === dto.key && alert.turnSeq === dto.turnSeq)) return;
      const destination = destinationForProject(dto.project);
      if (!destination || destinationMode(destination) === "off" || !paired() || ["disabled", "webhook_conflict", "poll_conflict"].includes(state) ||
        isMuted(dto.key)) return;
      queue.push(cardAlert(dto, response, destination));
      scheduleDrain();
    } catch (error) { report("telegram observe", error); }
  };

  const parseCommand = (text: string): { command: string; arg?: string; ignored?: boolean } | undefined => {
    if (!topicsEnabled) {
      const [command, arg] = text.split(/\s+/, 2);
      return { command: command ?? "", arg };
    }
    const match = /^(\/[A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return undefined;
    if (match[2] && (!botUsername || match[2].toLowerCase() !== botUsername.toLowerCase())) return { command: match[1].toLowerCase(), arg: match[3], ignored: true };
    return { command: match[1].toLowerCase(), arg: match[3]?.trim() };
  };
  const bindingConfirmation = (chatTitle: string | undefined, groupChatId: string, name: string, general: boolean) =>
    `Bound <b>${escapeHtml(clipped(redact(chatTitle || groupChatId), 256))}</b> / <b>${escapeHtml(name)}</b>.${general ? " (General)" : ""}`;
  const bindTopic = async (name: string, message: TelegramMessage, destination: Destination, bindings: TopicBindings | null) => {
    if (!/^[a-z0-9][a-z0-9/_-]{0,63}$/.test(name)) {
      await retrySendAt(destination, "Use a lower-case topic name with letters, numbers, /, _ or -."); return;
    }
    const chat = message.chat!;
    if (chat.type === "group") { await retrySendAt(destination, "Use a supergroup with topics."); return; }
    if (chat.type !== "supergroup") { await retrySendAt(destination, "Use /bind in a supergroup topic."); return; }
    const groupId = String(chat.id), threadId = message.message_thread_id === 1 ? null : message.message_thread_id ?? null;
    if (threadId !== null && (!Number.isSafeInteger(threadId) || threadId <= 0)) { await retrySendAt(destination, "That topic has an invalid ID."); return; }
    if (bindings && bindings.groupChatId !== groupId) return;
    const topics = { ...(bindings?.topics ?? {}) };
    for (const [boundName, boundThread] of Object.entries(topics)) if (boundThread === threadId && boundName !== name) delete topics[boundName];
    topics[name] = threadId;
    db.setSetting("telegram.topics", JSON.stringify({ groupChatId: groupId, topics }));
    await retrySend(bindingConfirmation(chat.title, groupId, name, threadId === null));
  };
  const unbindTopic = async (name: string, destination: Destination, bindings: TopicBindings | null) => {
    if (!bindings || !Object.hasOwn(bindings.topics, name)) {
      await retrySendAt(destination, `No binding named <b>${escapeHtml(clipped(name, 80))}</b>.`); return;
    }
    const topics = { ...bindings.topics };
    delete topics[name];
    if (Object.keys(topics).length) db.setSetting("telegram.topics", JSON.stringify({ groupChatId: bindings.groupChatId, topics }));
    else db.deleteSetting("telegram.topics");
    await retrySendAt(destination, `Unbound <b>${escapeHtml(name)}</b>.`);
  };
  const handleMessage = async (message: TelegramMessage) => {
    const chat = message.chat, from = message.from, rawText = message.text ?? "", text = rawText.trim();
    if (!chat || !from) return;
    const parsedCommand = parseCommand(text);
    if (parsedCommand?.ignored) return;
    if (!paired()) {
      refreshPairing();
      const match = (topicsEnabled ? /^\/pair(?:@[A-Za-z0-9_]+)?\s+([0-9A-Za-z]+)\s*$/i : /^\/pair\s+([0-9A-Za-z]+)\s*$/i).exec(text);
      if (chat.type === "private" && match && now() < pairingExpires && match[1].toUpperCase() === pairing) {
        setPaired(String(chat.id), String(from.id), from.username ?? "");
        await retrySend("Paired. You'll get alerts here.");
      }
      return;
    }
    if (String(from.id) !== userId) return;
    const bindings = readBindings(), incomingChatId = String(chat.id);
    const bootstrapBind = topicsEnabled && parsedCommand?.command === "/bind" && !!parsedCommand.arg && chat.type === "supergroup" && !bindings;
    const bootstrapBasicGroup = topicsEnabled && parsedCommand?.command === "/bind" && !!parsedCommand.arg && chat.type === "group";
    const privateDm = incomingChatId === chatId && (!topicsEnabled || chat.type === "private");
    const boundGroup = !!bindings && incomingChatId === bindings.groupChatId && chat.type === "supergroup";
    if (!privateDm && !boundGroup && !bootstrapBind && !bootstrapBasicGroup) return;
    const destination = incomingDestination(message);
    // Telegram marks every non-reply message inside a forum topic as a reply to the topic's creation service message.
    // That is not a reply to an alert: drop plain text, but still handle commands such as /bind@bot in the topic.
    const topicRoot = !!message.reply_to_message?.forum_topic_created;
    if (topicRoot && (!topicsEnabled || !parsedCommand)) return;
    const replyTo = topicRoot ? undefined : message.reply_to_message;
    if (replyTo?.message_id !== undefined) {
      const prompt = db.telegramQuestionMessage(incomingChatId, replyTo.message_id);
      if (prompt?.prompt) {
        if (prompt.threadId !== destination.threadId) {
          clearTelegramQuestionMessage(prompt);
          await retrySendAt(destination, "That question prompt belongs to another topic.");
          return;
        }
        await handleCustomQuestionReply(message, prompt, rawText);
        return;
      }
    }
    if (topicsEnabled && !text && !replyTo) return;
    const hint = "I can't match that message to a session. Reply to a single-session alert, or use /status then /r N your text.";
    if (replyTo && (topicsEnabled ? !parsedCommand : !text.startsWith("/"))) {
      if (!replies) { await retrySendAt(destination, "Replies are off on the hub."); return; }
      const messageId = replyTo.message_id;
      const alert = messageId === undefined ? undefined : db.alertFor(incomingChatId, messageId);
      if (!alert || alert.kind === "digest" || !alert.sessionKey) { await retrySendAt(destination, hint); return; }
      await routeReply(alert.sessionKey, text, destination, message.message_id);
      return;
    }
    if (!parsedCommand) {
      await retrySendAt(destination, "Reply to an alert to answer it, or use /status then /r N your text.");
      return;
    }
    const command = parsedCommand.command, arg = parsedCommand.arg;
    if (command === "/pair") {
      if (topicsEnabled && !privateDm) return;
      await retrySendAt(destination, "Reply to an alert to answer it, or use /status then /r N your text.");
      return;
    }
    if (command === "/bind") {
      if (!topicsEnabled) { await retrySendAt(destination, "Reply to an alert to answer it, or use /status then /r N your text."); return; }
      if (!arg) { await retrySendAt(destination, "Use /bind <topic-name> in a supergroup topic."); return; }
      await bindTopic(arg, message, destination, bindings);
    } else if (command === "/unbind") {
      if (!topicsEnabled) { await retrySendAt(destination, "Reply to an alert to answer it, or use /status then /r N your text."); return; }
      if (!arg) { await retrySendAt(destination, "Use /unbind <topic-name>."); return; }
      await unbindTopic(arg, destination, bindings);
    } else if (command === "/status") await retrySendAt(destination, statusText(destination));
    else if (command === "/r") {
      const match = topicsEnabled ? /^(\d+)\s+([\s\S]+)$/.exec(arg ?? "") : /^\/r\s+(\d+)\s+([\s\S]+)$/.exec(text);
      const key = match ? statusKeyAt(destination.chatId, destination.threadId, Number(match[1])) : undefined;
      if (!key) await retrySendAt(destination, "Run /status first.");
      else await routeReply(key, match![2], destination, message.message_id);
    } else if (command === "/cancel") {
      const cancelled = replies?.cancelAll() ?? [];
      await retrySendAt(destination, `Cancelled ${cancelled.length} pending replies.`);
    } else if (command === "/mode") {
      const topicMode = topicsEnabled && destination.name && destination.threadId !== null && !["general", "urgent"].includes(destination.name);
      const currentMode = topicMode ? destinationMode(destination, bindings) : mode;
      if (!arg) await retrySendAt(destination, `Mode: ${currentMode}`);
      else if (["input", "turns", "off"].includes(arg)) {
        if (topicMode) db.setSetting(`telegram.mode.${destination.name}`, arg as Mode);
        else { mode = arg as Mode; db.setSetting("telegram.mode", mode); }
        await retrySendAt(destination, `Mode: ${arg}`);
      } else await retrySendAt(destination, "Use /mode input, /mode turns, or /mode off.");
    } else if (command === "/mute") {
      const duration = { "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, off: 0 }[arg ?? "1h"];
      if (duration === undefined) await retrySendAt(destination, "Use /mute 30m, /mute 1h, /mute 4h, or /mute off.");
      else { db.setSetting("telegram.mute_until", String(duration ? now() + duration : 0)); await retrySendAt(destination, duration ? `Muted for ${arg ?? "1h"}.` : "Mute off."); }
    } else if (command === "/help") await retrySendAt(destination, [
      "<b>dash commands</b>",
      "<b>Sessions and replies</b>\n/status — list sessions and reply numbers\n/r N text — reply to a numbered session\n/cancel — cancel pending replies",
      "<b>Notifications</b>\n/mode input|turns|off — choose alert types\n/mute 30m|1h|4h|off — pause or resume alerts",
      "<b>Help</b>\n/help — show this guide\nYou can also reply to an alert to answer it.",
      ...(topicsEnabled && botUsername ? [`In group topics, use /cmd@${escapeHtml(botUsername)} in place of /cmd.`] : []),
    ].join("\n\n"));
    else await retrySendAt(destination, "Reply to an alert to answer it, or use /status then /r N your text.");
  };
  const answerCallback = async (callback: TelegramCallback, text: string) => {
    try { await call("answerCallbackQuery", { callback_query_id: callback.id, text }); }
    catch (error) { report("telegram callback", error); }
  };
  const staleCard = async (callback: TelegramCallback, card: Card) => {
    db.markCardState(card.id, "stale");
    clearKeyboard(card);
    await answerCallback(callback, "Out of date: the session has moved on");
  };
  // R4/R6: every check, the submit and the card's sent mark run synchronously before the first await,
  // so a replayed or concurrent tap can never queue a second reply.
  const handleCard = async (callback: TelegramCallback, callbackChatId: string, data: string) => {
    const match = cardCode.exec(data), messageId = callback.message?.message_id;
    const card = match ? db.getCard(parseInt(match[1], 36)) : undefined;
    const group = Number(match?.[2]), option = Number(match?.[3]), set = card?.decisions.decisions ?? [];
    // Retired recommendation codes (99:1 and 99:2) are never accepted, including on older messages.
    const offered = group === 99 ? option >= 3 && option <= 5 || option === 0 && set.length > 1
      : option < (set[group]?.options.length ?? 0);
    if (!card || card.chatId !== callbackChatId || messageId === undefined || card.messageId !== messageId || card.state !== "active" ||
      card.expiresAt <= now() || !card.picks || !offered) {
      await answerCallback(callback, "Expired, use /status"); return;
    }
    if (!replies) { await answerCallback(callback, "Replies are off on the hub."); return; }
    const dto = db.getSession(card.sessionKey);
    // A newer stored response (a backfilled message the turn never counted) means the card no longer shows the last message.
    if (!dto || dto.turnSeq !== card.turnSeq || dto.lastResponses[0]?.id !== card.responseId) { await staleCard(callback, card); return; }
    if (group === 99 && option === 5) {
      muted.set(card.sessionKey, now() + 3_600_000);
      await answerCallback(callback, `Muted ${clipped(dto.displayName, 60)} for 1h`); return;
    }
    if (group === 99 && option === 4) {
      const pages = formatTelegramContent(redact(db.getResponse(card.responseId)?.text ?? ""));
      await answerCallback(callback, "Sending the full text.");
      let destination: Destination = { chatId: card.chatId, threadId: card.threadId, name: null };
      for (let part = 0; part < pages.length; part++) {
        const sentAt = await queueSend(destination, `<b>Full text${pages.length > 1 ? ` · Part ${part + 1}/${pages.length}` : ""}</b>\n${pages[part]}`);
        if (!sentAt) return;
        destination = { ...sentAt, name: null };
      }
      return;
    }
    if (group < 99 && set.length > 1) {
      const toggled = db.togglePick(card.id, group, option);
      if (!toggled) { await answerCallback(callback, "Expired, use /status"); return; }
      markup(card, () => liveKeyboard(card.id)?.inline_keyboard);
      await answerCallback(callback, `${toggled.picks?.[group] === option ? "Picked" : "Cleared"} ${group + 1}: ${set[group]!.options[option]!.key}`);
      return;
    }
    // A single decision's option sends at once; Send picks uses the stored picks.
    const picks = group < 99 ? { 0: option } : option === 0 ? card.picks : undefined;
    const label = picks ? clipped(choiceSummary(set, picks), 200) : CONTINUE_LABEL;
    submittingCards.add(card.id);
    let submitted: ReturnType<NonNullable<typeof replies>["submit"]>;
    try {
      submitted = replies.submit({ key: card.sessionKey, text: picks ? choiceText(set, picks) : CONTINUE_TEXT,
        source: "telegram", actor: `telegram:${userId}`, answersTurn: card.turnSeq });
      if (!("refused" in submitted)) db.markCardSent(card.id, submitted.replyId);
    } finally { submittingCards.delete(card.id); }
    if ("refused" in submitted) {
      if (submitted.reason === "stale_turn") await staleCard(callback, card);
      else await answerCallback(callback, replyRefusal(submitted.reason));
      return;
    }
    // A waiting Claude hook can take the reply inside submit(), before the card knew its reply id.
    const reply = db.getReply(submitted.replyId);
    const outcome = reply && Object.hasOwn(outcomeLine, reply.state) ? reply.state as Outcome : undefined;
    clearKeyboard(card);
    cardStatus(card, label, outcome);
    await answerCallback(callback, `Sent to ${clipped(dto.displayName, 60)}`);
  };
  const handleCallback = async (callback: TelegramCallback) => {
    const callbackChat = callback.message?.chat, fromId = callback.from?.id;
    if (!paired() || String(fromId) !== userId || !callbackChat) return;
    const bindings = readBindings(), callbackChatId = String(callbackChat.id);
    const privateDm = callbackChatId === chatId && (!topicsEnabled || callbackChat.type === "private");
    const boundGroup = callbackChat.type === "supergroup" && !!bindings && callbackChatId === bindings.groupChatId;
    if (!privateDm && !boundGroup) return;
    if (callback.data?.startsWith("q:")) { await handleQuestionCallback(callback, callbackChatId, callback.data); return; }
    if (callback.data?.startsWith("d:")) { await handleCard(callback, callbackChatId, callback.data); return; }
    const id = callback.data?.startsWith("ms:") ? callback.data.slice(3) : "";
    const key = ids.get(id), dto = key ? db.listSessions(true, true).find(row => row.key === key) : undefined;
    if (key && dto) muted.set(key, now() + 3_600_000);
    await answerCallback(callback, dto ? `Muted ${clipped(dto.displayName, 60)} for 1h` : "Expired");
  };
  const handleUpdate = async (update: Update) => {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  };
  const run = async () => {
    while (running && base) {
      try {
        if (badTokenNeedsWait) { await wait(60_000); badTokenNeedsWait = false; if (!running) return; }
        let loaded: string | undefined;
        try { loaded = (await readToken())?.trim(); }
        catch (error) { report("telegram token", error); }
        if (!loaded || !tokenPattern.test(loaded)) { token = undefined; state = "no_token"; await wait(60_000); continue; }
        token = loaded;
        const me = await call<{ username?: string }>("getMe", {});
        botUsername = me.username ?? null;
        const webhook = await call<{ url?: string }>("getWebhookInfo", {});
        if (webhook.url) { state = "webhook_conflict"; await wait(60_000); continue; }
        state = paired() ? "ok" : "unpaired";
        seedUrgentEpisodes();
        restoreQuestionCards();
        reconcileAlerts();
        let backoff = 2_000;
        while (running && token) {
          try {
            const offset = Number(db.getSetting("telegram.offset") ?? 0);
            const updates = await call<Update[]>("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
            for (const update of updates) {
              try { await handleUpdate(update); }
              catch (error) { report("telegram update", error); }
              finally { db.setSetting("telegram.offset", String(update.update_id + 1)); }
            }
            backoff = 2_000;
          } catch (error) {
            if (!running) return;
            if (error instanceof ApiError && error.status === 409) { state = "poll_conflict"; await wait(600_000); break; }
            if (error instanceof ApiError && [401, 404].includes(error.status)) { state = "bad_token"; token = undefined; badTokenNeedsWait = true; break; }
            state = "error"; report("telegram poll", error); await wait(backoff); backoff = Math.min(backoff * 2, 60_000);
            if (running && token) state = paired() ? "ok" : "unpaired";
          }
        }
      } catch (error) {
        if (!running) return;
        state = error instanceof ApiError && [401, 404].includes(error.status) ? "bad_token" : "error";
        report("telegram startup", error);
        await wait(60_000);
      }
    }
  };
  return {
    start() {
      if (!base || running) return;
      running = true;
      if (topicsEnabled) seedUrgentEpisodes();
      failStrandedCards();
      stopAlertTimer = setTimer(() => { sweepUrgentEpisodes(); sweepAlertUpdates(); failStrandedCards(); }, 60_000);
      void run();
    },
    close() { running = false; stopAlertTimer(); stopAlertTimer = () => {}; abort.abort(); queue.length = 0; token = undefined; },
    observe, observeDecisions, health, info, unpair, replyOutcome, sendUrgent,
  };
}

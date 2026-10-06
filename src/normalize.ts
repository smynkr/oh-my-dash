import { hostname } from "node:os";

export type Harness = "claude" | "omp";
export type EventKind = "session_start" | "prompt" | "question" | "question_answered" | "permission" | "notification" | "response" | "error" | "session_end";
export interface NormalizedEvent {
  host: string;
  harness: Harness;
  sessionId: string;
  kind: EventKind;
  ts: number;
  cwd?: string;
  title?: string;
  text?: string;
  detail?: string;
  questionIdentity?: string;
  questionData?: OmpAskQuestion[];
  interactive: boolean;
  transcriptPath?: string;
  backgroundTasks?: number;
  sessionKind?: string;
}

export interface OmpAskOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface OmpAskQuestion {
  id: string;
  question: string;
  header?: string;
  options: OmpAskOption[];
  multi?: boolean;
  recommended?: number;
}

export interface PendingQuestion {
  id: string;
  questions: OmpAskQuestion[];
}

const textLimit = 100 * 1024;
const detailLimit = 4 * 1024;
type Data = Record<string, unknown>;
const obj = (value: unknown): Data | null => value && typeof value === "object" && !Array.isArray(value) ? value as Data : null;
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
export const clip = (value: unknown, limit = textLimit): string | undefined => {
  const input = str(value);
  if (input === undefined || Buffer.byteLength(input, "utf8") <= limit) return input;
  let low = 0, high = input.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(input.slice(0, mid), "utf8") <= limit) low = mid;
    else high = mid - 1;
  }
  return input.slice(0, low);
};
const json = (value: unknown, limit = detailLimit): string | undefined => {
  if (value === undefined) return undefined;
  try { return clip(JSON.stringify(value), limit); } catch { return undefined; }
};
export const localHost = () => hostname().split(".")[0];
export const sessionKey = (event: Pick<NormalizedEvent, "host" | "harness" | "sessionId">) => `${event.host}|${event.harness}|${event.sessionId}`;
export const claudeInteractive = (headers: Headers) => headers.get("X-Dash-Entrypoint") === "cli";

export function describePrompt(text: string | undefined | null): string | null {
  if (text == null) return null;
  const trimmed = text.trimStart();
  if (/^<task-notification(?:\s|>)/.test(trimmed)) {
    const summary = trimmed.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
    return `⟲ Background task update${summary ? `: ${summary.slice(0, 160)}` : ""}`;
  }
  const command = trimmed.match(/^<(?:command-name|command-message)>([\s\S]*?)<\/(?:command-name|command-message)>/);
  if (command) {
    const name = command[1].trim().replace(/^\//, "");
    const args = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return `/${name}${args ? ` ${args}` : ""}`;
  }
  if (/^(?:<system-reminder(?:\s|>)|<local-command-stdout(?:\s|>)|Caveat:)/.test(trimmed)) return null;
  return text;
}

function questionFields(input: Data | null) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const texts = questions.map((q) => str(obj(q)?.question)).filter((x): x is string => !!x);
  const options = questions.map((q) => obj(q)?.options).filter((x) => x !== undefined);
  return { text: clip(texts.length ? texts.join("\n") : json(input, textLimit)), detail: json(options) };
}

export function normalizeClaude(payload: unknown, headers: Headers, ts = Date.now()): NormalizedEvent | null {
  const data = obj(payload);
  if (!data || typeof data.session_id !== "string" || !data.session_id) return null;
  const name = str(data.hook_event_name);
  const host = (headers.get("X-Dash-Host") || localHost()).split(".")[0].slice(0, 255);
  const base: Omit<NormalizedEvent, "kind"> = {
    host, harness: "claude", sessionId: data.session_id, ts,
    cwd: clip(data.cwd, 4096), transcriptPath: clip(data.transcript_path, 4096),
    interactive: claudeInteractive(headers), sessionKind: clip(headers.get("X-Dash-Kind"), 255),
  };
  const input = obj(data.tool_input);
  switch (name) {
    case "SessionStart": return { ...base, kind: "session_start", detail: clip(data.source, detailLimit) };
    case "UserPromptSubmit": return { ...base, kind: "prompt", text: clip(data.prompt) };
    case "PreToolUse": {
      if (data.tool_name !== "AskUserQuestion") return null;
      return { ...base, kind: "question", ...questionFields(input) };
    }
    case "PostToolUse": return data.tool_name === "AskUserQuestion" ? { ...base, kind: "question_answered" } : null;
    case "PermissionRequest": return data.tool_name === "AskUserQuestion"
      ? { ...base, kind: "question", ...questionFields(input) }
      : { ...base, kind: "permission", detail: clip(data.tool_name, detailLimit), text: json(input, 2048) };
    case "Notification": return { ...base, kind: "notification", text: clip(data.message), detail: clip(data.notification_type, detailLimit) };
    case "Stop": return { ...base, kind: "response", text: clip(data.last_assistant_message), backgroundTasks: Array.isArray(data.background_tasks) ? data.background_tasks.length : 0 };
    case "StopFailure": return { ...base, kind: "error", text: clip(data.last_assistant_message) };
    case "SessionEnd": return { ...base, kind: "session_end", detail: clip(data.reason, detailLimit) };
    default: return null;
  }
}

const questionIdentityPattern = /^[A-Za-z0-9_-]{8,128}$/;
const questionDataByteLimit = 32 * 1024;
const boundedQuestionString = (value: unknown, maxBytes: number): string | undefined =>
  typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;

export function normalizeOmpQuestions(value: unknown): OmpAskQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return undefined;
  const questions: OmpAskQuestion[] = [];
  for (const entry of value) {
    const question = obj(entry);
    if (!question) return undefined;
    const id = boundedQuestionString(question.id, 256);
    const text = boundedQuestionString(question.question, 8192);
    if (id === undefined || text === undefined || !Array.isArray(question.options) || question.options.length > 64) return undefined;
    const options: OmpAskOption[] = [];
    for (const rawOption of question.options) {
      const option = obj(rawOption);
      if (!option) return undefined;
      const label = boundedQuestionString(option.label, 2048);
      if (label === undefined) return undefined;
      const normalized: OmpAskOption = { label };
      for (const key of ["description", "preview"] as const) {
        if (option[key] === undefined) continue;
        const bounded = boundedQuestionString(option[key], key === "description" ? 4096 : 8192);
        if (bounded === undefined) return undefined;
        normalized[key] = bounded;
      }
      options.push(normalized);
    }
    const normalized: OmpAskQuestion = { id, question: text, options };
    if (question.header !== undefined) {
      const header = boundedQuestionString(question.header, 256);
      if (header === undefined) return undefined;
      normalized.header = header;
    }
    if (question.multi !== undefined) {
      if (typeof question.multi !== "boolean") return undefined;
      normalized.multi = question.multi;
    }
    if (Number.isInteger(question.recommended) && Number(question.recommended) >= 0 &&
        Number(question.recommended) < options.length) normalized.recommended = Number(question.recommended);
    questions.push(normalized);
  }
  return Buffer.byteLength(JSON.stringify(questions), "utf8") <= questionDataByteLimit ? questions : undefined;
}

const kinds: Record<EventKind, true> = {
  session_start: true, prompt: true, question: true, question_answered: true, permission: true,
  notification: true, response: true, error: true, session_end: true,
};
export function normalizeOmp(payload: unknown, ts = Date.now()): NormalizedEvent | null {
  const data = obj(payload);
  if (!data || data.harness !== "omp" || typeof data.host !== "string" || !data.host || typeof data.sessionId !== "string" || !data.sessionId || !Object.hasOwn(kinds, data.kind as EventKind) || typeof data.interactive !== "boolean") return null;
  const kind = data.kind as EventKind;
  const questionIdentity = typeof data.questionIdentity === "string" && questionIdentityPattern.test(data.questionIdentity)
    ? data.questionIdentity : undefined;
  const questionData = kind === "question" ? normalizeOmpQuestions(data.questionData) : undefined;
  const questionFields = kind === "question" && questionIdentity
    ? { questionIdentity, ...(questionData ? { questionData } : {}) }
    : {};
  const answerIdentity = kind === "question_answered" ? questionIdentity : undefined;
  return {
    host: data.host.split(".")[0].slice(0, 255), harness: "omp", sessionId: data.sessionId.slice(0, 1024),
    kind, ts, cwd: clip(data.cwd, 4096), title: clip(data.title, 4096),
    text: clip(data.text), detail: clip(data.detail, detailLimit), interactive: data.interactive,
    transcriptPath: clip(data.transcriptPath, 4096),
    ...questionFields,
    ...(answerIdentity ? { questionIdentity: answerIdentity } : {}),
  };
}

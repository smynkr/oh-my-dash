import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

export type Harness = "claude" | "omp" | "codex" | "agy";
export type CodexAction = "turn/start" | "turn/steer" | "turn/interrupt";
export type EventKind = "session_start" | "prompt" | "question" | "question_answered" | "permission" | "notification" | "response" | "error" | "session_end";

export interface CodexControlInfo {
  source: string;
  appServerOwned: boolean;
  version?: string;
  turnStart: boolean;
  turnSteer: boolean;
  turnInterrupt: boolean;
  activeTurnId?: string | null;
}
export interface NormalizedEvent {
  host: string;
  harness: Harness;
  sessionId: string;
  kind: EventKind;
  ts: number;
  cwd?: string;
  title?: string;
  accountAlias?: string;
  text?: string;
  detail?: string;
  questionIdentity?: string;
  toolUseId?: string;
  questionData?: AskQuestion[];
  interactive: boolean;
  transcriptPath?: string;
  backgroundTasks?: number;
  sessionKind?: string;
  prompt?: string;
  responseSource?: "backfill";
  codexControl?: CodexControlInfo;
}

export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: AskOption[];
  multi?: boolean;
  recommended?: number;
}

export interface PendingQuestion {
  id: string;
  questions: AskQuestion[];
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

// Explicit display metadata only: never infer an account from credentials or app login.
export function normalizeAccountAlias(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const alias = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(alias) ? alias : undefined;
}

export function stripAgyPromptEnvelope(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const requestMatch = value.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (requestMatch) return requestMatch[1]!;
  const cleaned = value
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/g, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
  return cleaned || undefined;
}

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
    accountAlias: normalizeAccountAlias(headers.get("X-Dash-Account-Alias")),
    ...(typeof data.tool_use_id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(data.tool_use_id)
      ? { toolUseId: data.tool_use_id } : {}),
  };
  const input = obj(data.tool_input);
  switch (name) {
    case "SessionStart": return { ...base, kind: "session_start", detail: clip(data.source, detailLimit) };
    case "UserPromptSubmit": return { ...base, kind: "prompt", text: clip(data.prompt) };
    case "PreToolUse": {
      if (data.tool_name !== "AskUserQuestion") return null;
      const questionData = normalizeClaudeQuestions(input?.questions);
      return { ...base, kind: "question", ...questionFields(input), ...(questionData ? { questionData } : {}) };
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

export function normalizeQuestions(value: unknown): AskQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return undefined;
  const questions: AskQuestion[] = [];
  for (const entry of value) {
    const question = obj(entry);
    if (!question) return undefined;
    const id = boundedQuestionString(question.id, 256);
    const text = boundedQuestionString(question.question, 8192);
    if (id === undefined || text === undefined || !Array.isArray(question.options) || question.options.length > 64) return undefined;
    const options: AskOption[] = [];
    for (const rawOption of question.options) {
      const option = obj(rawOption);
      if (!option) return undefined;
      const label = boundedQuestionString(option.label, 2048);
      if (label === undefined) return undefined;
      const normalized: AskOption = { label };
      for (const key of ["description", "preview"] as const) {
        if (option[key] === undefined) continue;
        const bounded = boundedQuestionString(option[key], key === "description" ? 4096 : 8192);
        if (bounded === undefined) return undefined;
        normalized[key] = bounded;
      }
      options.push(normalized);
    }
    const normalized: AskQuestion = { id, question: text, options };
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

export function normalizeClaudeQuestions(value: unknown): AskQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return undefined;
  const questions: AskQuestion[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const question = obj(entry);
    if (!question) return undefined;
    const text = boundedQuestionString(question.question, 8192);
    if (text === undefined || !text.trim() || seen.has(text) ||
        !Array.isArray(question.options) || question.options.length > 64) return undefined;
    seen.add(text);
    const options: AskOption[] = [];
    for (const rawOption of question.options) {
      const option = obj(rawOption);
      if (!option) return undefined;
      const label = boundedQuestionString(option.label, 2048);
      if (label === undefined || !label.trim()) return undefined;
      const normalized: AskOption = { label };
      if (option.description !== undefined) {
        const description = boundedQuestionString(option.description, 4096);
        if (description === undefined) return undefined;
        normalized.description = description;
      }
      options.push(normalized);
    }
    const normalized: AskQuestion = { id: String(questions.length), question: text, options };
    if (question.header !== undefined) {
      const header = boundedQuestionString(question.header, 256);
      if (header === undefined) return undefined;
      normalized.header = header;
    }
    if (question.multiSelect !== undefined) {
      if (typeof question.multiSelect !== "boolean") return undefined;
      normalized.multi = question.multiSelect;
    }
    if (Number.isInteger(question.recommended) && Number(question.recommended) >= 0 &&
        Number(question.recommended) < options.length) normalized.recommended = Number(question.recommended);
    questions.push(normalized);
  }
  return Buffer.byteLength(JSON.stringify(questions), "utf8") <= questionDataByteLimit ? questions : undefined;
}
export interface QuestionSelection {
  selectedOptions: number[];
  customInput?: string;
}

export function normalizeQuestionSelections(questions: AskQuestion[], value: unknown): Record<string, string> | undefined {
  const raw = obj(value);
  if (!raw || Object.keys(raw).length !== questions.length) return undefined;
  const answers = Object.create(null) as Record<string, string>;
  for (const question of questions) {
    if (!Object.hasOwn(raw, question.question)) return undefined;
    const selection = obj(raw[question.question]);
    if (!selection || Object.keys(selection).some(key => key !== "selectedOptions" && key !== "customInput") ||
        !Array.isArray(selection.selectedOptions)) return undefined;
    const selected = selection.selectedOptions;
    if (selected.length > question.options.length || selected.some(index => !Number.isInteger(index) ||
        (index as number) < 0 || (index as number) >= question.options.length) ||
        new Set(selected).size !== selected.length || question.multi !== true && selected.length > 1) return undefined;
    let custom: string | undefined;
    if (selection.customInput !== undefined) {
      custom = boundedQuestionString(selection.customInput, 16 * 1024);
      if (custom === undefined || !custom.trim() || [...custom].length > 4000 ||
          /[\x00-\x08\x0b-\x1f\x7f]/.test(custom)) return undefined;
    }
    if (question.multi !== true && custom !== undefined && selected.length) return undefined;
    if (question.multi !== true && !selected.length && custom === undefined) return undefined;
    const labels = selected.map(index => question.options[index]!.label);
    answers[question.question] = [...labels, ...(custom === undefined ? [] : [custom])].join(", ");
    if (Buffer.byteLength(answers[question.question]!, "utf8") > questionDataByteLimit) return undefined;
  }
  return answers;
}

export function normalizeQuestionAnswerMap(questions: AskQuestion[], value: unknown): Record<string, string> | undefined {
  const raw = obj(value);
  if (!raw || Object.keys(raw).length !== questions.length) return undefined;
  const answers = Object.create(null) as Record<string, string>;
  for (const question of questions) {
    const answer = raw[question.question];
    if (!Object.hasOwn(raw, question.question) || typeof answer !== "string" ||
        Buffer.byteLength(answer, "utf8") > questionDataByteLimit ||
        answer !== "" && !answer.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(answer)) return undefined;
    answers[question.question] = answer;
  }
  return answers;
}

export function normalizeRecommendedQuestionAnswers(questions: AskQuestion[], value: unknown): Record<string, string> | undefined {
  const answers = normalizeQuestionAnswerMap(questions, value);
  if (!answers) return undefined;
  for (const question of questions) {
    const index = question.recommended;
    if (!Number.isSafeInteger(index) || index! < 0 || index! >= question.options.length ||
        answers[question.question] !== question.options[index!]!.label) return undefined;
  }
  return answers;
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
  const questionData = kind === "question" ? normalizeQuestions(data.questionData) : undefined;
  const questionFields = kind === "question" && questionIdentity
    ? { questionIdentity, ...(questionData ? { questionData } : {}) }
    : {};
  const answerIdentity = kind === "question_answered" ? questionIdentity : undefined;
  return {
    host: data.host.split(".")[0].slice(0, 255), harness: "omp", sessionId: data.sessionId.slice(0, 1024),
    kind, ts, cwd: clip(data.cwd, 4096), title: clip(data.title, 4096),
    text: clip(data.text), detail: clip(data.detail, detailLimit), interactive: data.interactive,
    transcriptPath: clip(data.transcriptPath, 4096),
    accountAlias: normalizeAccountAlias(data.accountAlias),
    ...questionFields,
    ...(answerIdentity ? { questionIdentity: answerIdentity } : {}),
  };
}
export function normalizeCodex(payload: unknown, headers: Headers, ts = Date.now()): NormalizedEvent | null {
  const data = obj(payload);
  if (!data || data.harness !== "codex" || typeof data.host !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(data.host) || typeof data.sessionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(data.sessionId) || !Object.hasOwn(kinds, data.kind as EventKind) ||
      typeof data.interactive !== "boolean") return null;
  const boundHost = headers.get("X-Dash-Host");
  if (boundHost !== null && boundHost !== data.host) return null;
  const rawControl = obj(data.codexControl);
  let codexControl: CodexControlInfo | undefined;
  if (rawControl && typeof rawControl.source === "string" && rawControl.source.length <= 64 &&
      typeof rawControl.appServerOwned === "boolean" && typeof rawControl.turnStart === "boolean" &&
      typeof rawControl.turnSteer === "boolean" && typeof rawControl.turnInterrupt === "boolean") {
    const version = typeof rawControl.version === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(rawControl.version)
      ? rawControl.version : undefined;
    const activeTurnId = rawControl.activeTurnId === null ? null
      : typeof rawControl.activeTurnId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(rawControl.activeTurnId)
        ? rawControl.activeTurnId : undefined;
    codexControl = {
      source: rawControl.source,
      appServerOwned: rawControl.appServerOwned,
      turnStart: rawControl.turnStart,
      turnSteer: rawControl.turnSteer,
      turnInterrupt: rawControl.turnInterrupt,
      ...(version ? { version } : {}),
      ...(activeTurnId !== undefined ? { activeTurnId } : {}),
    };
  }
  const accountAlias = normalizeAccountAlias(data.accountAlias);
  if (data.accountAlias !== undefined && accountAlias === undefined) return null;
  const eventTs = typeof data.ts === "number" && Number.isSafeInteger(data.ts) && data.ts >= 0 ? data.ts : ts;
  return {
    host: data.host,
    harness: "codex",
    sessionId: data.sessionId,
    kind: data.kind as EventKind,
    ts: eventTs,
    cwd: clip(data.cwd, 4096),
    title: clip(data.title, 4096),
    ...(accountAlias ? { accountAlias } : {}),
    text: clip(data.text),
    prompt: clip(data.prompt),
    detail: clip(data.detail, detailLimit),
    interactive: data.interactive,
    responseSource: data.responseSource === "backfill" ? "backfill" : undefined,
    ...(codexControl ? { codexControl } : {}),
  };
}

export function normalizeAgyQuestions(value: unknown): AskQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return undefined;
  const questions: AskQuestion[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const question = obj(entry);
    if (!question) return undefined;
    const text = boundedQuestionString(question.question, 8192);
    if (text === undefined || !text.trim() || seen.has(text) ||
        !Array.isArray(question.options) || question.options.length < 1 || question.options.length > 64) return undefined;
    seen.add(text);
    const options: AskOption[] = [];
    const markedRecommended: number[] = [];
    for (let idx = 0; idx < question.options.length; idx++) {
      const rawOption = question.options[idx];
      if (typeof rawOption === "string") {
        const bounded = boundedQuestionString(rawOption, 2048);
        if (bounded === undefined || !bounded.trim()) return undefined;
        const trimmed = bounded.trim();
        const prefixMatch = trimmed.match(/^\(recommended\)\s+(.+)$/i);
        const suffixMatch = !prefixMatch ? trimmed.match(/^(.+?)\s+\(recommended\)$/i) : null;
        if (prefixMatch || suffixMatch) markedRecommended.push(idx);
        const cleanLabel = (prefixMatch?.[1] ?? suffixMatch?.[1] ?? trimmed).trim();
        if (!cleanLabel) return undefined;
        options.push({ label: cleanLabel });
        continue;
      }
      const option = obj(rawOption);
      if (!option) return undefined;
      const label = boundedQuestionString(option.label, 2048);
      if (label === undefined || !label.trim()) return undefined;
      if (/^\(recommended\)\s+/i.test(label) || /\s+\(recommended\)$/i.test(label)) markedRecommended.push(idx);
      const cleanLabel = label.replace(/^\(recommended\)\s+/i, "").replace(/\s+\(recommended\)$/i, "").trim() || label.trim();
      const normalizedOption: AskOption = { label: cleanLabel };
      for (const key of ["description", "preview"] as const) {
        if (option[key] === undefined) continue;
        const bounded = boundedQuestionString(option[key], key === "description" ? 4096 : 8192);
        if (bounded === undefined) return undefined;
        normalizedOption[key] = bounded;
      }
      options.push(normalizedOption);
    }
    const id = boundedQuestionString(question.id, 256) ?? String(questions.length);
    const normalized: AskQuestion = { id, question: text, options };
    if (question.header !== undefined) {
      const header = boundedQuestionString(question.header, 256);
      if (header === undefined) return undefined;
      normalized.header = header;
    }
    const rawMulti = question.is_multi_select ?? question.multiSelect ?? question.multi;
    if (rawMulti !== undefined) {
      if (typeof rawMulti !== "boolean") return undefined;
      normalized.multi = rawMulti;
    }
    if (Number.isInteger(question.recommended) && Number(question.recommended) >= 0 &&
        Number(question.recommended) < options.length) {
      normalized.recommended = Number(question.recommended);
    } else if (normalized.multi !== true && markedRecommended.length === 1) {
      normalized.recommended = markedRecommended[0];
    }
    questions.push(normalized);
  }
  return Buffer.byteLength(JSON.stringify(questions), "utf8") <= questionDataByteLimit ? questions : undefined;
}

export function resolveWorkspacePath(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    const raw = value.trim();
    if (raw.startsWith("file://")) {
      try { return fileURLToPath(raw); } catch { return undefined; }
    }
    if (raw.startsWith("[")) {
      try { return resolveWorkspacePath(JSON.parse(raw)); } catch { return undefined; }
    }
    return raw;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = resolveWorkspacePath(item);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

export function normalizeAgy(payload: unknown, headers: Headers, ts = Date.now()): NormalizedEvent | null {
  const data = obj(payload);
  if (!data) return null;
  const sessionId = str(data.conversationId ?? data.sessionId ?? data.conversation_id ?? data.session_id);
  if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  const headerHost = headers.get("X-Dash-Host");
  const rawHost = (headerHost || str(data.host) || localHost()).split(".")[0]!.slice(0, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(rawHost)) return null;
  if (headerHost !== null && typeof data.host === "string" && data.host && data.host.split(".")[0] !== headerHost.split(".")[0]) {
    return null;
  }
  const name = str(data.hookEventName ?? data.hook_event_name ?? data.kind);
  const cwd = clip(resolveWorkspacePath(data.cwd) ?? resolveWorkspacePath(data.workspacePaths) ?? resolveWorkspacePath(data.workspace_uris), 4096);
  const transcriptPath = clip(data.transcriptPath ?? data.transcript_path, 4096);
  const nestingDepth = typeof data.nestingDepth === "number" ? data.nestingDepth : typeof data.nesting_depth === "number" ? data.nesting_depth : undefined;
  const interactive = typeof data.interactive === "boolean"
    ? data.interactive
    : nestingDepth !== undefined
      ? nestingDepth === 0
      : headers.get("X-Dash-Entrypoint") !== "headless";
  const sessionKind = clip(headers.get("X-Dash-Kind") ?? data.sessionKind ?? (nestingDepth !== undefined && nestingDepth > 0 ? "bg" : undefined), 255);
  const accountAlias = normalizeAccountAlias(headers.get("X-Dash-Account-Alias") ?? data.accountAlias ?? data.account_alias);
  const toolCall = obj(data.toolCall);
  const rawToolId = str(toolCall?.id ?? data.tool_use_id ?? data.toolUseId);
  const toolUseId = rawToolId && /^[A-Za-z0-9_-]{1,256}$/.test(rawToolId) ? rawToolId : undefined;
  const rawQuestionIdentity = str(data.questionIdentity ?? data.questionId);
  const questionIdentity = rawQuestionIdentity && questionIdentityPattern.test(rawQuestionIdentity)
    ? rawQuestionIdentity
    : (toolUseId && questionIdentityPattern.test(toolUseId) ? toolUseId : undefined);
  const eventTs = typeof data.ts === "number" && Number.isSafeInteger(data.ts) && data.ts >= 0 ? data.ts : ts;
  const base: Omit<NormalizedEvent, "kind"> = {
    host: rawHost,
    harness: "agy",
    sessionId,
    ts: eventTs,
    cwd,
    title: clip(data.title, 4096),
    transcriptPath,
    interactive,
    sessionKind,
    accountAlias,
    ...(toolUseId ? { toolUseId } : {}),
  };
  const toolName = str(toolCall?.name ?? data.tool_name);
  const toolArgs = obj(toolCall?.args ?? data.tool_input);
  switch (name) {
    case "SessionStart":
    case "session_start":
      return { ...base, kind: "session_start", detail: clip(data.source ?? data.detail ?? data.modelName, detailLimit) };
    case "PreInvocation":
    case "UserPromptSubmit":
    case "prompt": {
      const promptText = stripAgyPromptEnvelope(data.lastUserInput ?? data.userPrompt ?? data.prompt ?? data.text);
      return { ...base, kind: "prompt", text: clip(promptText) };
    }
    case "PreToolUse":
    case "question": {
      if (name === "PreToolUse" && toolName !== "ask_question" && toolName !== "AskUserQuestion") return null;
      const rawQuestions = toolArgs?.questions ?? data.questionData ?? data.questions;
      const questionData = normalizeAgyQuestions(rawQuestions) ?? normalizeQuestions(rawQuestions);
      const summary = questionData?.map(q => q.question).join("\n") ?? questionFields(toolArgs).text;
      const detail = questionData ? json(questionData.map(q => q.options)) : questionFields(toolArgs).detail;
      return {
        ...base,
        kind: "question",
        text: clip(summary),
        detail,
        ...(questionData ? { questionData } : {}),
        ...(questionIdentity ? { questionIdentity } : {}),
      };
    }
    case "PostToolUse":
    case "question_answered": {
      if (name === "PostToolUse" && toolName !== "ask_question" && toolName !== "AskUserQuestion") return null;
      return { ...base, kind: "question_answered", ...(questionIdentity ? { questionIdentity } : {}) };
    }
    case "PermissionRequest":
    case "permission":
      return { ...base, kind: "permission", detail: clip(toolName ?? data.detail, detailLimit), text: clip(data.text ?? json(toolArgs, 2048)) };
    case "Notification":
    case "notification":
      return { ...base, kind: "notification", text: clip(data.message ?? data.text), detail: clip(data.notification_type ?? data.detail, detailLimit) };
    case "Stop":
    case "response": {
      const canceled = str(data.terminationReason) === "USER_CANCELED";
      const responseText = canceled ? undefined : str(data.response ?? data.last_assistant_message ?? data.text);
      const errVal = data.error;
      const hasError = typeof errVal === "string" ? errVal.trim().length > 0 : Boolean(errVal && typeof errVal === "object");
      if (hasError && !responseText?.trim()) {
        const errText = typeof errVal === "string" ? errVal : str(obj(errVal)?.message) ?? json(errVal, 2048);
        return { ...base, kind: "error", text: clip(errText) };
      }
      if (data.continuationActive === true && !responseText?.trim()) return null;
      return {
        ...base,
        kind: "response",
        text: clip(responseText),
        prompt: clip(stripAgyPromptEnvelope(data.prompt ?? data.lastUserInput ?? data.userPrompt)),
        backgroundTasks: data.fullyIdle === false ? 1 : (typeof data.backgroundTasks === "number" ? data.backgroundTasks : 0),
        responseSource: data.responseSource === "backfill" ? "backfill" : undefined,
      };
    }
    case "StopFailure":
    case "error": {
      const errVal = data.error ?? data.text ?? data.last_assistant_message;
      const errText = typeof errVal === "string" ? errVal : str(obj(errVal)?.message) ?? json(errVal, 2048);
      return { ...base, kind: "error", text: clip(errText) };
    }
    case "SessionEnd":
    case "session_end":
      return { ...base, kind: "session_end", detail: clip(data.reason ?? data.detail, detailLimit) };
    default:
      return null;
  }
}

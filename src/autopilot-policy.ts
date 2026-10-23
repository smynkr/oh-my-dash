import { createHash } from "node:crypto";
import type { DecisionSet } from "./decisions.ts";
import { verifiedRecommendation } from "./decisions.ts";
import type { ResponseDTO, SessionDTO } from "./db.ts";
import type { AskQuestion } from "./normalize.ts";
export const AUTOPILOT_GLOBAL_REPLY_RATE_LIMIT = 30;


export type AutopilotAction = "continue" | "choose_option" | "reply" | "escalate" | "done";
export type AutopilotTemplate = "T_CONTINUE" | "T_CHOOSE_SINGLE" | "T_CHOOSE_MULTI";
export interface AutopilotVerdict {
  action: AutopilotAction;
  option_indices?: number[];
  reply_text?: string;
  rationale: string;
  confidence: number;
  risk_flags: string[];
}
export interface PolicyGoal {
  id: number;
  status: "active" | "paused" | "escalated" | "done" | "stopped";
  maxTurns: number;
  turnsUsed: number;
  expiresAt: number;
  lastResumedTurn: number;
}
export interface RecentAction {
  template: AutopilotTemplate | null;
  responseHash: string;
  decisionSetHash: string;
  status: string;
}
export interface PolicyInput {
  enabled: boolean;
  masterEnabled: boolean;
  goal: PolicyGoal;
  session: SessionDTO;
  expectedTurn: number;
  ownerReplyPending: boolean;
  latestTurnError: boolean;
  now: number;
  response: ResponseDTO;
  verdict: AutopilotVerdict;
  lastReplyAt: number | null;
  globalRepliesLastHour: number;
  recentActions: RecentAction[];
  customStopPhrases: string[];
  dialogQuestions?: AskQuestion[];
}
export type PolicyResult =
  | { kind: "drop"; reason: "disabled" | "stale" }
  | { kind: "defer"; reason: "cooldown"; until: number }
  | { kind: "escalate"; reason: string; suggestion?: string }
  | { kind: "send"; template: AutopilotTemplate }
  | { kind: "done" };

export const AUTOPILOT_VERDICT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["continue", "choose_option", "reply", "escalate", "done"] },
    option_indices: { type: "array", minItems: 1, maxItems: 8, items: { type: "integer", minimum: 0, maximum: 7 } },
    reply_text: { type: "string", maxLength: 2000 },
    rationale: { type: "string", maxLength: 600 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    risk_flags: { type: "array", maxItems: 8, items: { type: "string", maxLength: 64 } },
  },
  required: ["action", "rationale", "confidence", "risk_flags"],
});

const stopRules: Array<[string, RegExp[]]> = [
  ["force_push", [/\bforce[ -]push\b/i, /\bgit\s+push\b[^\n;|&]*(?:--force(?:-with-lease)?|(?:^|\s)-f(?:\s|$)|\s\+[^\s]+)/i]],
  ["branch_delete", [/\b(?:delete|remove|drop)\s+(?:the\s+)?(?:remote\s+)?branch\b/i, /\bgit\s+branch\b[^\n;|&]*(?:-[dD]\b|--delete\b)/i, /\bgit\s+push\b[^\n;|&]*--delete\b/i]],
  ["history_rewrite", [/\bgit\s+(?:rebase|filter-branch|filter-repo)\b/i, /\bgit\s+reset\s+--hard\b/i, /\bgit\s+commit\s+--amend\b/i, /\brewrite\s+(?:the\s+)?(?:git\s+)?history\b/i]],
  ["rm_rf", [
    /(?:^|[\s;&|])rm\s+(?:-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*|--recursive\b[^\n;|&]*--force\b|--force\b[^\n;|&]*--recursive\b)/i,
    /\brm\b[^\n;|&]*(?:--recursive\b|(?:^|\s)-[A-Za-z]*r[A-Za-z]*\b)[^\n;|&]*(?:--force\b|(?:^|\s)-[A-Za-z]*f[A-Za-z]*\b)/i,
    /\brm\b[^\n;|&]*(?:--force\b|(?:^|\s)-[A-Za-z]*f[A-Za-z]*\b)[^\n;|&]*(?:--recursive\b|(?:^|\s)-[A-Za-z]*r[A-Za-z]*\b)/i,
    /\brmdir\s+\/s\b/i, /\bfind\b[^\n;|&]*\s-delete\b/i,
    /\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\n;|&]*\bremove-item\b[^\n;|&]*(?:-recurse\b[^\n;|&]*-force\b|-force\b[^\n;|&]*-recurse\b)/i,
    /\b(?:(?:cmd(?:\.exe)?\s+\/c\s+))?del(?:\.exe)?\b[^\n;|&]*(?:\/s\b[^\n;|&]*\/q\b|\/q\b[^\n;|&]*\/s\b)/i,
    /\bgit\s+clean\b[^\n;|&]*(?:--force\b|-[A-Za-z]*f[A-Za-z]*\b)/i,
  ]],
  ["drop_truncate", [/\b(?:drop|truncate)\s+(?:table|database|schema|collection|index|view|function|trigger|type|sequence)\b/i]],
  ["secrets_iam", [/\b(?:keychain|op\s+item|gh\s+secret|aws\s+iam|gcloud\s+iam|azure\s+role|iam\s+(?:user|role|policy))\b/i, /\b(?:api[_ -]?key|secret[_ -]?key|access[_ -]?token)\b/i]],
  ["system_install", [/\b(?:brew\s+install|sudo\b|npm\s+(?:install|i)\s+-g|pnpm\s+(?:add|install)\s+-g|yarn\s+global\s+add)\b/i, /\bcurl\b[^\n;|]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/i]],
  ["global_config", [/\bgit\s+config\s+--global\b/i, /(?:^|[\s"'])~?\/(?:\.bashrc|\.zshrc|\.profile|\.gitconfig|\.claude\/settings(?:\.json)?)(?:$|[\s"'])/i, /\b(?:shell rc|global config|launchagents)\b/i]],
  ["email", [/\b(?:send|compose|forward|reply to)\s+(?:an?\s+)?(?:email|e-mail)\b/i, /\bemail\s+(?:the|to)\s+[\w.+-]+@/i]],
  ["payment_money", [
    /\b(?:place|submit|process|initiate)\s+(?:an?\s+)?(?:order|payment|purchase|transfer|charge)\b/i,
    /\b(?:buy|purchase|sell|charge|refund)\s+(?:a|an|the|this|that|these|those|[$€£]?\d+|[A-Za-z0-9_$])/i,
    /\b(?:pay|payment|charge|refund)\s+(?:for|to|the|a|an|invoice|bill|subscription|[$€£]?\d+)\b/i,
    /\b(?:transfer|wire|payout|withdraw)\s+(?:funds|money|[$€£]?\d+)\b/i,
    /\b(?:trade|trading)\s+(?:stocks?|crypto|options?|shares?|futures?|currencies)\b/i,
    /\b(?:checkout|payment processing|live trading|billing|settlement)\b/i, /\b(?:--live|LIVE_TRADING)\b/i,
  ]],
  ["accept_terms", [/\b(?:accept|agree to|consent to)\s+(?:the\s+)?(?:terms|terms of service|license agreement)\b/i]],
  ["dash_control", [/\b(?:dash\.sqlite|autopilot\.enabled|DASH_AUTOPILOT|DASH_DIALOGS)\b/i, /\/api\/[^\s"']+\b/i, /\b(?:enable|disable|pause|resume|stop|edit)\s+(?:the\s+)?(?:autopilot|goal|budget|kill switch)\b/i]],
];
const fold = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en-US");

export function matchStopAndAsk(text: string, customPhrases: readonly string[] = []): string | undefined {
  const normalized = fold(text);
  for (const [rule, patterns] of stopRules) if (patterns.some(pattern => pattern.test(normalized))) return rule;
  for (const phrase of customPhrases) {
    if (typeof phrase !== "string" || !phrase.trim()) continue;
    let codePoints = 0;
    for (const _ of phrase) if (++codePoints > 120) break;
    if (codePoints >= 1 && codePoints <= 120 && normalized.includes(fold(phrase))) return "custom_phrase";
  }
}

export function decisionSetHash(set: DecisionSet | null | undefined): string {
  const canonical = (set?.decisions ?? []).map(decision => ({
    title: fold(decision.title.trim().replace(/\s+/g, " ")),
    options: decision.options.map(option => fold(option.label.trim().replace(/\s+/g, " "))),
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const candidateTemplate = (action: AutopilotAction, decisions: DecisionSet | null): AutopilotTemplate | undefined => {
  if (action === "continue") return "T_CONTINUE";
  if (action !== "choose_option" || !decisions?.decisions.length) return undefined;
  return decisions.decisions.length === 1 ? "T_CHOOSE_SINGLE" : "T_CHOOSE_MULTI";
};

function chooseAllowed(verdict: AutopilotVerdict, response: ResponseDTO): boolean {
  const decisions = response.decisions?.decisions;
  const indices = verdict.option_indices;
  if (!decisions?.length || !indices || indices.length !== decisions.length) return false;
  return decisions.every((decision, index) => {
    const selected = indices[index];
    return Number.isInteger(selected) && selected === decision.recIndex && verifiedRecommendation(decision, response.text);
  });
}

function hasLoop(input: PolicyInput, template: AutopilotTemplate | undefined): boolean {
  const [newest, previous] = input.recentActions;
  if (newest?.status === "sent" && (newest.template === "T_CHOOSE_SINGLE" || newest.template === "T_CHOOSE_MULTI") &&
      newest.decisionSetHash === decisionSetHash(input.response.decisions)) return true;
  if (!template || !newest || !previous || newest.status !== "sent" || previous.status !== "sent") return false;
  return newest.template === template && previous.template === template &&
    [newest.responseHash, previous.responseHash].includes(createHash("sha1").update(input.response.text).digest("hex"));
}

function stopText(response: ResponseDTO, questions?: AskQuestion[]): string {
  const parts = [response.text];
  for (const decision of response.decisions?.decisions ?? []) {
    parts.push(decision.title, ...decision.options.map(option => option.label));
  }
  for (const question of questions ?? []) {
    parts.push(question.question, question.header ?? "");
    for (const option of question.options) parts.push(option.label, option.description ?? "", option.preview ?? "");
  }
  return parts.join("\n");
}

export function evaluateAutopilotPolicy(input: PolicyInput): PolicyResult {
  const { goal, session, response, verdict } = input;
  if (!input.enabled || !input.masterEnabled || goal.status !== "active") return { kind: "drop", reason: "disabled" };
  if (session.status !== "your_turn" || session.turnSeq !== input.expectedTurn || response.turnSeq !== input.expectedTurn ||
      input.ownerReplyPending) return { kind: "drop", reason: "stale" };
  if (input.latestTurnError && input.expectedTurn > goal.lastResumedTurn) return { kind: "escalate", reason: "session_error" };
  if (goal.turnsUsed >= goal.maxTurns || goal.expiresAt <= input.now) return { kind: "escalate", reason: "budget" };
  if (input.lastReplyAt !== null && input.now - input.lastReplyAt < 120_000)
    return { kind: "defer", reason: "cooldown", until: input.lastReplyAt + 120_000 };
  if (input.globalRepliesLastHour >= AUTOPILOT_GLOBAL_REPLY_RATE_LIMIT) return { kind: "escalate", reason: "rate" };

  const decisions = response.decisions;
  const template = candidateTemplate(verdict.action, decisions);
  if (hasLoop(input, template)) return { kind: "escalate", reason: "loop" };
  const stop = matchStopAndAsk(stopText(response, input.dialogQuestions), input.customStopPhrases);
  if (stop) return { kind: "escalate", reason: `stop_ask:${stop}` };
  if (verdict.action === "escalate") return { kind: "escalate", reason: "judge" };
  if (verdict.confidence < 0.7 || verdict.risk_flags.length > 0) return { kind: "escalate", reason: "judge" };
  if (verdict.action === "choose_option") return chooseAllowed(verdict, response) && template
    ? { kind: "send", template } : { kind: "escalate", reason: "near_tie" };
  if (verdict.action === "continue") return { kind: "send", template: "T_CONTINUE" };
  if (verdict.action === "reply") return { kind: "escalate", reason: "free_text", suggestion: verdict.reply_text };
  if (verdict.action === "done") return { kind: "done" };
  return { kind: "escalate", reason: "judge" };
}

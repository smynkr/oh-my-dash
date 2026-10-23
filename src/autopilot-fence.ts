import { matchStopAndAsk } from "./autopilot-policy.ts";

export type FenceTool = string;
export type FenceMatch = { deny: true; rule: string } | { deny: false };

const TOOL_LIMIT = 64 * 1024;
const NODE_LIMIT = 2048;
const DEPTH_LIMIT = 12;
const fileTools: Record<string, true> = {
  Read: true, Glob: true, Grep: true, Edit: true, Write: true, MultiEdit: true, NotebookEdit: true,
};
const sensitivePaths: Array<[string, RegExp]> = [
  ["secrets_iam", /(?:^|[\\/"'`\s])(?:~|\$HOME|\$\{HOME\}|\$env:HOME|%HOME%|%USERPROFILE%|\$\{USERPROFILE\}|\$env:USERPROFILE|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|\/Users\/[^/]+|\/home\/[^/]+|\/root|\/var\/root)[\\/]\.ssh(?:[\\/]|$)/i],
  ["secrets_iam", /(?:^|[\\/"'`\s])(?:\.\.?[\\/])?\.ssh(?:[\\/]|$)/i],
  ["secrets_iam", /(?:^|[\\/"'`\s])(?:~|\$HOME|\$\{HOME\}|\$env:HOME|%HOME%|%USERPROFILE%|\$\{USERPROFILE\}|\$env:USERPROFILE|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|\/Users\/[^/]+|\/home\/[^/]+|\/root|\/var\/root)[\\/]\.aws(?:[\\/]|$)/i],
  ["secrets_iam", /(?:^|[\\/"'`\s])(?:\.\.?[\\/])?\.aws(?:[\\/]|$)/i],
  ["global_config", /(?:^|[\\/"'`\s])(?:~|\$HOME|\$\{HOME\}|\$env:HOME|%HOME%|%USERPROFILE%|\$\{USERPROFILE\}|\$env:USERPROFILE|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|\/Users\/[^/]+|\/home\/[^/]+|\/root|\/var\/root)[\\/](?:\.bashrc|\.zshrc|\.profile|\.gitconfig)(?:$|[\\/\s"'`])/i],
  ["global_config", /(?:^|[\\/"'`\s])(?:~|\$HOME|\$\{HOME\}|\$env:HOME|%HOME%|%USERPROFILE%|\$\{USERPROFILE\}|\$env:USERPROFILE|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|\/Users\/[^/]+|\/home\/[^/]+|\/root|\/var\/root)[\\/]\.claude[\\/]settings[^\\/\s"'`]*/i],
  ["system_install", /(?:^|[\\/"'`\s])(?:~|\$HOME|\$\{HOME\}|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+|\/Users\/[^/]+|\/root|\/var\/root)[\\/]Library[\\/]LaunchAgents(?:[\\/]|$)/i],
  ["dash_control", /(?:^|[\\/\s"'`])[^\\/\s"'`]*dash\.sqlite(?:$|[\\/\s"'`])/i],
];
const toolAliases: Record<string, string> = {
  bash: "Bash", read: "Read", glob: "Glob", grep: "Grep", edit: "Edit", write: "Write",
  multi_edit: "MultiEdit", "multi-edit": "MultiEdit", notebook_edit: "NotebookEdit", "notebook-edit": "NotebookEdit",
};
const safeTools = new Set(["ask", "askuserquestion", "enterplanmode", "exitplanmode", "todowrite"]);

type CollectState = { nodes: number; chars: number; strings: string[]; seen: Set<object> };
function collectStrings(value: unknown, state: CollectState, depth = 0, includeKeys = false): boolean {
  if (typeof value === "string") {
    state.chars += value.length;
    if (state.chars > TOOL_LIMIT) return false;
    state.strings.push(value);
    return true;
  }
  if (!value || typeof value !== "object") return true;
  if (depth >= DEPTH_LIMIT || ++state.nodes > NODE_LIMIT || state.seen.has(value)) return false;
  state.seen.add(value);
  if (includeKeys && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.replace(/[_-]+/g, " ");
      state.chars += normalizedKey.length;
      if (state.chars > TOOL_LIMIT) return false;
      state.strings.push(normalizedKey);
      if (item === true) {
        const flag = `--${key.replace(/_/g, "-")}`;
        state.chars += flag.length;
        if (state.chars > TOOL_LIMIT) return false;
        state.strings.push(flag);
      }
      if (!collectStrings(item, state, depth + 1, true)) return false;
    }
    return true;
  }
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const item of values) if (!collectStrings(item, state, depth + 1, includeKeys)) return false;
  return true;
}

function sensitiveMcpToolRule(tool: string): string | undefined {
  if (/^mcp__.*(?:email|mail)/i.test(tool)) return "email";
  if (/^mcp__.*(?:charge|payment|purchase|checkout|order|trade|transfer|payout|withdraw|refund|settlement|invoice|billing)/i.test(tool))
    return "payment_money";
  if (/^mcp__.*dash/i.test(tool)) return "dash_control";
  return undefined;
}

function matchingRule(tool: string, text: string, customPhrases: readonly string[]): string | undefined {
  const toolRule = sensitiveMcpToolRule(tool);
  if (toolRule) return toolRule;
  for (const [rule, pattern] of sensitivePaths) if (pattern.test(text)) return rule;
  return matchStopAndAsk(text, customPhrases);
}

export function fenceMatch(tool: FenceTool, input: unknown, customPhrases: readonly string[] = []): FenceMatch {
  if (typeof tool !== "string" || !tool || !input || typeof input !== "object")
    return { deny: true, rule: "uninspectable" };
  const normalizedTool = toolAliases[tool.toLowerCase()] ?? tool;
  const isMcp = /^mcp__/i.test(normalizedTool);
  const mcpText = isMcp
    ? normalizedTool.slice(5).replace(/__/g, " ").replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim()
    : normalizedTool;
  const mcpToolRule = sensitiveMcpToolRule(normalizedTool);
  if (mcpToolRule) return { deny: true, rule: mcpToolRule };
  const state: CollectState = { nodes: 0, chars: 0, strings: [], seen: new Set() };
  if (!collectStrings(input, state, 0, isMcp)) return { deny: true, rule: "uninspectable" };

  if (normalizedTool === "Bash") {
    const command = (input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).command : undefined);
    if (typeof command !== "string") return { deny: true, rule: "uninspectable" };
  } else if (Object.hasOwn(fileTools, normalizedTool)) {
    const fields = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const target = [fields.file_path, fields.path, fields.pattern, fields.glob].some(value => typeof value === "string" && value.length > 0);
    if (!target) return { deny: true, rule: "uninspectable" };
  } else if (!isMcp && !safeTools.has(normalizedTool.toLowerCase())) {
    return { deny: true, rule: "uninspectable" };
  }

  const rawText = [mcpText, ...state.strings].join(isMcp ? " " : "\n");
  const text = normalizedTool === "Bash" ? rawText.replace(/["'`]/g, "") : rawText;
  const rule = matchingRule(normalizedTool, text, customPhrases);
  return rule ? { deny: true, rule } : { deny: false };
}

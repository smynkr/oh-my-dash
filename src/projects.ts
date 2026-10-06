import { basename } from "node:path";

export type ProjectRule = { pattern: string; project: string };
export type TopicBindings = { groupChatId: string; topics: Record<string, number | null> };
export type TopicBinding = { chatId: string; threadId: number | null; name: string };

export const SEED_PROJECT_RULES: readonly ProjectRule[] = Object.freeze([
  Object.freeze({ pattern: "/(?:Documents|projects|Code|workspaces)/([^/]+)(?:/|$)", project: "$1" }),
]);

const compiledRules = new WeakMap<readonly ProjectRule[], { pattern: RegExp; project: string }[]>();
function compileRules(rules: readonly ProjectRule[]): { pattern: RegExp; project: string }[] {
  const cached = compiledRules.get(rules);
  if (cached) return cached;
  const compiled: { pattern: RegExp; project: string }[] = [];
  for (const rule of rules) {
    try { compiled.push({ pattern: new RegExp(rule.pattern), project: rule.project }); } catch {}
  }
  compiledRules.set(rules, compiled);
  return compiled;
}

export function resolveProject(cwd: string | undefined | null, rules: readonly ProjectRule[]): string {
  if (!cwd || cwd === "/") return "";

  for (const rule of compileRules(rules)) {
    const match = rule.pattern.exec(cwd);
    if (!match) continue;
    return rule.project.replace(/\$(\d+)/g, (_placeholder, group: string) => {
      const index = Number(group);
      return index > 0 ? match?.[index] ?? "" : "";
    });
  }

  return basename(cwd);
}

function validChatId(value: unknown): value is string {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric !== 0;
}

function validTopicName(value: string): boolean {
  return /^[a-z0-9][a-z0-9/_-]{0,63}$/.test(value);
}

function validBindings(value: TopicBindings | null): value is TopicBindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!validChatId(value.groupChatId) || !value.topics || typeof value.topics !== "object" || Array.isArray(value.topics)) return false;
  const binding = value as TopicBindings & Record<string, unknown>;
  if (Object.keys(binding).some(key => key !== "groupChatId" && key !== "topics")) return false;

  return Object.entries(value.topics).every(([name, threadId]) =>
    validTopicName(name) && (threadId === null || (Number.isSafeInteger(threadId) && Number(threadId) > 0)));
}

export function topicFor(project: string, bindings: TopicBindings | null): TopicBinding | null {
  if (!validBindings(bindings)) return null;

  const projectName = project.toLowerCase();
  const entries = Object.entries(bindings.topics);
  let selected = entries.find(([name]) => name === projectName);
  if (!selected && projectName) {
    selected = entries.find(([name]) => name.split("/").includes(projectName));
  }
  selected ??= entries.find(([name]) => name === "general");
  if (!selected) return null;

  return { chatId: bindings.groupChatId, threadId: selected[1], name: selected[0] };
}

export function ruleErrors(rules: readonly ProjectRule[]): { index: number; error: "invalid regex" }[] {
  const errors: { index: number; error: "invalid regex" }[] = [];
  rules.forEach((rule, index) => {
    try {
      new RegExp(rule.pattern);
    } catch {
      errors.push({ index, error: "invalid regex" });
    }
  });
  return errors;
}

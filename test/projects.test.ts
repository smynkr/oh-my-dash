import { expect, test } from "bun:test";
import { resolveProject, ruleErrors, SEED_PROJECT_RULES, topicFor, type TopicBindings } from "../src/projects.ts";

test("generic workspace roots map to their project and preserve fallback basenames", () => {
  expect(resolveProject("/Users/agent/projects/alpha/task", SEED_PROJECT_RULES)).toBe("alpha");
  expect(resolveProject("/Users/agent/Documents/beta", SEED_PROJECT_RULES)).toBe("beta");
  expect(resolveProject("/Users/agent/Code/gamma/src", SEED_PROJECT_RULES)).toBe("gamma");
  expect(resolveProject("/Users/agent/workspaces/delta", SEED_PROJECT_RULES)).toBe("delta");
  expect(resolveProject("/Users/agent/checkouts/unmatched/repo", SEED_PROJECT_RULES)).toBe("repo");
  expect(resolveProject("test-path", [
    { pattern: "test", project: "first" },
    { pattern: "test", project: "second" },
  ])).toBe("first");
  expect(resolveProject("/tmp/rogue/", [])).toBe("rogue");
  for (const cwd of ["", "/", null, undefined]) expect(resolveProject(cwd, SEED_PROJECT_RULES)).toBe("");
});

test("capture substitutions expand and invalid regex rules are reported and skipped", () => {
  const rules = [
    { pattern: "[", project: "broken" },
    { pattern: "^/work/([^/]+)/([^/]+)", project: "$2-$1-$3-$0" },
  ];
  expect(ruleErrors(rules)).toEqual([{ index: 0, error: "invalid regex" }]);
  expect(resolveProject("/work/Ada/engine", rules)).toBe("engine-Ada--");
});

test("topic selection prefers exact, then component, then General bindings", () => {
  const bindings: TopicBindings = {
    groupChatId: "-1001234567890",
    topics: {
      "squad/alpha": 42,
      "squad/beta": 43,
      alpha: 44,
      general: null,
      urgent: 46,
    },
  };

  expect(topicFor("alpha", bindings)).toEqual({ chatId: "-1001234567890", threadId: 44, name: "alpha" });
  expect(topicFor("beta", bindings)).toEqual({ chatId: "-1001234567890", threadId: 43, name: "squad/beta" });
  expect(topicFor("unmatched", bindings)).toEqual({ chatId: "-1001234567890", threadId: null, name: "general" });
  expect(topicFor("urgent-project", { ...bindings, topics: { urgent: 46 } })).toBeNull();
  expect(topicFor("unmatched", { ...bindings, topics: { urgent: 46 } })).toBeNull();
  expect(topicFor("alpha", null)).toBeNull();
});

test("malformed stored topic bindings are rejected", () => {
  const valid: TopicBindings = { groupChatId: "12345", topics: { alpha: 42, general: null } };
  expect(topicFor("alpha", { ...valid, groupChatId: "9007199254740992" })).toBeNull();
  expect(topicFor("alpha", { ...valid, groupChatId: "not-decimal" })).toBeNull();
  expect(topicFor("alpha", { ...valid, topics: { Alpha: 42 } })).toBeNull();
  expect(topicFor("alpha", { ...valid, topics: { alpha: 0 } })).toBeNull();
  expect(topicFor("alpha", { ...valid, topics: { alpha: Number.MAX_SAFE_INTEGER + 1 } })).toBeNull();
});

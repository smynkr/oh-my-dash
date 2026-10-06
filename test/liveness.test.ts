import { test, expect } from "bun:test";
import { parseClaudeAgents, pollClaudeAgents, resolveClaudeBin } from "../src/liveness.ts";

test("Claude agent parser accepts both response shapes and rejects other data", () => {
  const agent = { sessionId: "synthetic-s1", pid: 10, cwd: "/synthetic", name: "Test", status: "idle" };
  const expected = [{ host: "mbp", harness: "claude", sessionId: "synthetic-s1", pid: 10, cwd: "/synthetic", name: "Test", detail: "idle" }];
  expect(parseClaudeAgents([agent, { pid: 12 }], "mbp")).toEqual(expected);
  expect(parseClaudeAgents({ agents: [agent] }, "mbp")).toEqual(expected);
  expect(() => parseClaudeAgents({ foo: 1 }, "mbp")).toThrow("Invalid Claude agents response");
});

test("a failed Claude poll rejects instead of reporting an empty successful list", async () => {
  const previous = process.env.DASH_CLAUDE_BIN;
  process.env.DASH_CLAUDE_BIN = "/synthetic/nonexistent/claude";
  try { await expect(pollClaudeAgents()).rejects.toThrow(); }
  finally {
    if (previous === undefined) delete process.env.DASH_CLAUDE_BIN;
    else process.env.DASH_CLAUDE_BIN = previous;
  }
});

test("Claude binary resolver prefers configured path, accepts only absolute shell results, and falls back locally", async () => {
  const calls: string[][] = [];
  const fakeExec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return { stdout: "claude\n" };
  };
  expect(await resolveClaudeBin(fakeExec, { DASH_CLAUDE_BIN: "/synthetic/claude" }, "/synthetic/home")).toBe("/synthetic/claude");
  expect(calls).toHaveLength(0);
  expect(await resolveClaudeBin(fakeExec, {}, "/synthetic/home")).toBe("/synthetic/home/.local/bin/claude");
  expect(await resolveClaudeBin(fakeExec, { DASH_CLAUDE_BIN: "claude" }, "/synthetic/home")).toBe("/synthetic/home/.local/bin/claude");
  expect(calls).toEqual([["/bin/zsh", "-lc", "whence -p claude"], ["/bin/zsh", "-lc", "whence -p claude"]]);
  expect(await resolveClaudeBin(async () => ({ stdout: "/opt/synthetic/bin/claude\n" }), {}, "/synthetic/home")).toBe("/opt/synthetic/bin/claude");
});

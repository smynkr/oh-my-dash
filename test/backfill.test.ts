import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeTranscript, parseOmpTranscript, scanBackfill } from "../src/backfill.ts";

let dir: string;
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const file = (name: string, entries: unknown[]) => {
  const path = join(dir, name);
  writeFileSync(path, entries.map(line).join(""));
  return path;
};
const stamp = (index: number) => new Date(2026, 0, 1, 0, 0, index).toISOString();
const claudeUser = (index: number, content: unknown = `synthetic prompt ${index}`) => ({
  type: "user", sessionId: "synthetic-claude", cwd: "/synthetic/project", timestamp: stamp(index), message: { content },
});
const claudeAssistant = (index: number, id: string, content: unknown) => ({
  type: "assistant", sessionId: "synthetic-claude", timestamp: stamp(index), message: { id, content },
});
const text = (value: string) => ({ type: "text", text: value });

beforeEach(() => { dir = mkdtempSync(join(process.cwd(), ".tmp-backfill-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Claude transcript backfill", () => {
  test("takes the last three real turns, merges assistant blocks, and uses the last ai-title", () => {
    const path = file("claude.jsonl", [
      { type: "progress", entrypoint: "cli" },
      { type: "ai-title", aiTitle: "Old synthetic title" },
      claudeUser(1), claudeAssistant(1, "one", [text("response one")]),
      { ...claudeUser(2), isSidechain: true }, claudeAssistant(2, "sidechain", [text("sidechain response")]),
      { ...claudeUser(3), isMeta: true }, claudeAssistant(3, "meta", [text("meta response")]),
      claudeUser(4, [{ type: "tool_result", content: "tool output" }]),
      claudeAssistant(4, "tool-only", [{ type: "tool_use", name: "Read" }]),
      claudeUser(5), claudeAssistant(5, "old", [text("earlier draft")]),
      claudeAssistant(5, "new", [text("final ")]), claudeAssistant(5, "new", [text("two")]),
      claudeUser(6), claudeAssistant(6, "three", [text("response three")]),
      claudeUser(7), claudeAssistant(7, "four", [text("response four")]),
      { type: "ai-title", aiTitle: "Final synthetic title" },
    ]);
    const result = parseClaudeTranscript(path);
    expect(result).toMatchObject({ harness: "claude", sessionId: "synthetic-claude", cwd: "/synthetic/project", title: "Final synthetic title", interactive: true });
    expect(result?.responses.map(r => r.text)).toEqual(["final two", "response three", "response four"]);
    expect(result?.responses.map(r => r.prompt)).toEqual(["synthetic prompt 5", "synthetic prompt 6", "synthetic prompt 7"]);
  });

  test("skips sdk-py transcripts", () => {
    const path = file("sdk.jsonl", [
      { type: "progress", entrypoint: "sdk-py" }, claudeUser(1), claudeAssistant(1, "one", [text("synthetic response")]),
    ]);
    expect(parseClaudeTranscript(path)).toBeNull();
  });

  test("reads a transcript larger than 20 MB from its tail and expands when needed", () => {
    const path = join(dir, "large.jsonl");
    const padding = (size: number) => line({ type: "progress", padding: "x".repeat(size) });
    const contents = [
      line({ type: "progress", entrypoint: "cli" }),
      padding(16 * 1024 * 1024),
      line(claudeUser(1)), line(claudeAssistant(1, "one", [text("tail response one")])),
      padding(2 * 1024 * 1024),
      line(claudeUser(2)), line(claudeAssistant(2, "two", [text("tail response two")])),
      padding(2 * 1024 * 1024),
      line(claudeUser(3)), line(claudeAssistant(3, "three", [text("tail response three")])),
      padding(2 * 1024 * 1024),
    ];
    writeFileSync(path, contents.join(""));
    const result = parseClaudeTranscript(path);
    expect(result?.responses.map(r => r.text)).toEqual([
      "tail response one", "tail response two", "tail response three",
    ]);
  });
});

describe("OMP transcript backfill", () => {
  test("uses user text boundaries, final assistant text, and the latest title", () => {
    const path = file("omp.jsonl", [
      { type: "session", id: "synthetic-omp", cwd: "/synthetic/omp", title: "Old title" },
      { type: "title", title: "Synthetic OMP title" },
      { type: "message", message: { role: "user", content: [text("prompt one")] }, timestamp: stamp(1) },
      { type: "message", message: { role: "assistant", content: [text("response one")] }, timestamp: stamp(1) },
      { type: "message", message: { role: "user", content: [{ type: "tool_result", text: "tool output" }] } },
      { type: "message", message: { role: "user", content: [text("prompt two")] }, timestamp: stamp(2) },
      { type: "message", message: { role: "assistant", content: [text("response two")] }, timestamp: stamp(2) },
      { type: "message", message: { role: "user", content: [text("prompt three")] }, timestamp: stamp(3) },
      { type: "message", message: { role: "assistant", content: [text("response three")] }, timestamp: stamp(3) },
      { type: "message", message: { role: "user", content: [text("prompt four")] }, timestamp: stamp(4) },
      { type: "message", message: { role: "assistant", content: [text("response four")] }, timestamp: stamp(4) },
    ]);
    const result = parseOmpTranscript(path);
    expect(result).toMatchObject({ harness: "omp", sessionId: "synthetic-omp", cwd: "/synthetic/omp", title: "Synthetic OMP title" });
    expect(result?.responses.map(r => r.text)).toEqual(["response two", "response three", "response four"]);
  });

  test("imports parent OMP sessions only and skips nested subagent headers", async () => {
    const sessions = join(dir, "sessions");
    const deck = join(dir, "agent-deck");
    mkdirSync(join(sessions, "project"), { recursive: true });
    mkdirSync(join(sessions, "project", "nested"), { recursive: true });
    mkdirSync(join(deck, "instance", "nested"), { recursive: true });
    const parentEntries = [
      { type: "session", id: "parent-session", cwd: "/synthetic/omp" },
      { type: "message", message: { role: "user", content: [text("parent prompt")] } },
      { type: "message", message: { role: "assistant", content: [text("parent response")] } },
    ];
    writeFileSync(join(sessions, "project", "parent.jsonl"), parentEntries.map(line).join(""));
    writeFileSync(join(sessions, "project", "nested", "too-deep.jsonl"), parentEntries.map(line).join(""));
    writeFileSync(join(deck, "instance", "nested", "child.jsonl"), [
      line({ type: "session", id: "child-session", parentSession: "parent-session" }), ...parentEntries.slice(1).map(line),
    ].join(""));
    const found = await scanBackfill(12, {
      now: Date.now() + 1000,
      roots: [{ path: sessions, omp: true, sessionsDepth: true }, { path: deck, omp: true }],
    });
    expect(found.map(session => session.sessionId)).toEqual(["parent-session"]);
  });
});

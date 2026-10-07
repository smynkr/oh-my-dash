import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

const script = join(process.cwd(), "scripts/claude-question.py");
const servers: Array<ReturnType<typeof Bun.serve>> = [];
type FakeOptions = { answers?: Record<string, string>; waitStatus?: number; registerStatus?: number; slowBody?: boolean };
type HookRequest = { path: string; method: string; host: string | null; entrypoint: string | null; body?: unknown };

function fakeHub(options: FakeOptions = {}) {
  const requests: HookRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url), item: HookRequest = {
        path: url.pathname, method: request.method, host: request.headers.get("x-dash-host"),
        entrypoint: request.headers.get("x-dash-entrypoint"),
      };
      if (request.method === "POST" && url.pathname === "/question/register") item.body = await request.json();
      requests.push(item);
      if (url.pathname === "/question/register") return Response.json({}, { status: options.registerStatus ?? 201 });
      if (url.pathname === "/question/wait") {
        if (options.slowBody) {
          // A separate Python process owns the socket/monotonic clock; Bun fake timers cannot drive it.
          const encoder = new TextEncoder();
          let cancelled = false;
          return new Response(new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode('{"answers":'));
              for (let index = 0; index < 12; index++) {
                await Bun.sleep(150);
                if (cancelled) return;
                controller.enqueue(encoder.encode(" "));
              }
              controller.enqueue(encoder.encode(`${JSON.stringify(options.answers)}}`));
              controller.close();
            },
            cancel() { cancelled = true; },
          }), { headers: { "Content-Type": "application/json" } });
        }
        // Exercise Python's real monotonic deadline while keeping the 204 polling loop bounded.
        if (options.waitStatus === 204) { await Bun.sleep(200); return new Response(null, { status: 204 }); }
        return Response.json({ answers: options.answers }, { status: options.waitStatus ?? 200 });
      }
      if (url.pathname === "/question/cancel") return Response.json({ ok: true });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, requests };
}

async function runHook(base: string, payload: unknown, timeoutMs: number) {
  const proc = Bun.spawn(["python3", script, "--hub-url", base, "--host", "synthetic-host", "--timeout-ms", String(timeoutMs)], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

describe("Claude synchronous AskUserQuestion hook", () => {
  test("preserves Unicode, multi-question answers and the original tool input", async () => {
    const questions = [
      { question: "Choose a route? 🧭", header: "Plan", options: [
        { label: "Keep (Recommended)", description: "Preserve the current route" }, { label: "Replace" },
      ] },
      { question: "Which colors?", options: [{ label: "Red & gold" }, { label: "Blue" }], multiSelect: true },
    ];
    const answers = {
      "Choose a route? 🧭": "Keep (Recommended)",
      "Which colors?": "Red & gold, Blue, My own shade 🧪",
    };
    const payload = {
      hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", session_id: "synthetic-session",
      tool_use_id: "toolu_synthetic_question", tool_input: { questions, metadata: { untouched: true } },
    };
    const hub = fakeHub({ answers });
    const result = await runHook(hub.base, payload, 5000);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { ...payload.tool_input, answers },
    } });
  });

  test("a deadline without a user answer emits no hook decision and cancels its pending registration", async () => {
    const hub = fakeHub({ waitStatus: 204 });
    const result = await runHook(hub.base, {
      hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", session_id: "synthetic-session",
      tool_use_id: "toolu_synthetic_question", tool_input: { questions: [
        { question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
      ] },
    }, 1000);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(hub.requests.some(request => request.path === "/question/register")).toBe(true);
    expect(hub.requests.some(request => request.path === "/question/cancel" && request.method === "DELETE")).toBe(true);
  });

  test("a slow response body cannot deliver an answer past the question deadline", async () => {
    const hub = fakeHub({ slowBody: true, answers: { "Continue?": "Yes" } });
    const result = await runHook(hub.base, {
      hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", session_id: "synthetic-session",
      tool_use_id: "toolu_synthetic_question", tool_input: { questions: [
        { question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
      ] },
    }, 1000);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(hub.requests.some(request => request.path === "/question/cancel")).toBe(true);
  });

  test.each([
    { hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion" },
    { hook_event_name: "PreToolUse", tool_name: "ExitPlanMode" },
  ])("unrelated permission event or tool never registers or allows: %j", async event => {
    const hub = fakeHub({ answers: { "Continue?": "Yes" } });
    const result = await runHook(hub.base, { ...event, session_id: "synthetic-session",
      tool_use_id: "synthetic-tool", tool_input: { questions: [
        { question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
      ] },
    }, 1000);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(hub.requests).toEqual([]);
  });

  test("a mismatched answer map falls back without allowing AskUserQuestion", async () => {
    const hub = fakeHub({ answers: { "A different question?": "Yes" } });
    const result = await runHook(hub.base, {
      hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", session_id: "synthetic-session",
      tool_use_id: "toolu_synthetic_question", tool_input: { questions: [
        { question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
      ] },
    }, 5000);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(hub.requests.some(request => request.path === "/question/cancel" && request.method === "DELETE")).toBe(true);
  });

  test("an unavailable hub emits no hook decision", async () => {
    const hub = fakeHub({ registerStatus: 503 });
    const result = await runHook(hub.base, {
      hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", session_id: "synthetic-session",
      tool_use_id: "toolu_synthetic_question", tool_input: { questions: [
        { question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
      ] },
    }, 5000);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(hub.requests).toHaveLength(1);
    expect(hub.requests[0].path).toBe("/question/register");
  });
});

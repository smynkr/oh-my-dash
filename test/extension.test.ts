import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import extension, { chooseDelivery, resolveHost } from "../omp-extension/dash.ts";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
const originalFetch = globalThis.fetch;
const originalUrl = process.env.DASH_URL;
const originalHeadless = process.env.DASH_ALLOW_HEADLESS;
const originalReplyUrl = process.env.DASH_REPLY_URL;
const originalHost = process.env.DASH_HOST;
let handlers: Map<string, Handler>;
let posts: Array<{ url: string; body: Record<string, unknown>; options: RequestInit }>;
const interactiveCtx = { mode: "tui", cwd: "/synthetic/project", sessionManager: { getSessionId: () => "synthetic-session" } };
const headlessCtx = { ...interactiveCtx, mode: "rpc" };

function fire(name: string, event: Record<string, unknown> = {}, ctx: Record<string, unknown> = interactiveCtx): void {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Missing handler: ${name}`);
  handler(event, ctx);
}

beforeEach(() => {
  handlers = new Map();
  posts = [];
  process.env.DASH_URL = "http://127.0.0.1:4777/synthetic-omp";
  delete process.env.DASH_REPLY_URL;
  delete process.env.DASH_HOST;
  delete process.env.DASH_ALLOW_HEADLESS;
  globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
    if (String(url).includes("/reply/wait/omp")) return Promise.resolve(new Response(null, { status: 404 }));
    if (String(url).includes("/reply/commit")) return Promise.resolve(Response.json({ ok: true }));
    if (String(url).includes("/reply/ack")) return Promise.resolve(new Response("{}"));
    posts.push({ url: String(url), body: JSON.parse(String(options?.body)), options: options ?? {} });
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  extension({ on: (name, handler) => handlers.set(name, handler), getSessionName: () => "Synthetic title" });
});

afterEach(() => {
  const shutdown = handlers.get("session_shutdown");
  shutdown?.({}, interactiveCtx);
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.DASH_URL;
  else process.env.DASH_URL = originalUrl;
  if (originalHeadless === undefined) delete process.env.DASH_ALLOW_HEADLESS;
  else process.env.DASH_ALLOW_HEADLESS = originalHeadless;
  if (originalReplyUrl === undefined) delete process.env.DASH_REPLY_URL;
  else process.env.DASH_REPLY_URL = originalReplyUrl;
  if (originalHost === undefined) delete process.env.DASH_HOST;
  else process.env.DASH_HOST = originalHost;
});

describe("OMP feed extension", () => {
  test("resolveHost accepts a valid override and falls back for invalid values", () => {
    const fallback = () => "Fallback.Host.example";
    expect(resolveHost({}, fallback)).toBe("Fallback");
    expect(resolveHost({ DASH_HOST: "" }, fallback)).toBe("Fallback");
    expect(resolveHost({ DASH_HOST: "WORKSTATION" }, fallback)).toBe("WORKSTATION");
    for (const DASH_HOST of ["bad.label", "has space", "x".repeat(65)]) {
      expect(resolveHost({ DASH_HOST }, fallback)).toBe("Fallback");
    }
  });

const syntheticAskQuestions = [
  {
    id: "synthetic-choice", header: "Choice", question: "Choose a synthetic route?",
    options: [
      { label: "1. Synthetic option one", description: "First description" },
      { label: "3. Synthetic option three", description: "Recommended description", preview: "Synthetic preview" },
      { label: "4. Synthetic option four" },
    ],
    recommended: 1,
  },
  {
    id: "synthetic-flags", question: "Choose synthetic flags?",
    options: [{ label: "Alpha" }, { label: "Beta" }],
    multi: true,
  },
];

  test("ask tool start preserves every structured question and its option metadata", () => {
    fire("tool_execution_start", { toolName: "ask", toolCallId: "synthetic-call", args: { questions: syntheticAskQuestions } });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ host: expect.any(String), harness: "omp", sessionId: "synthetic-session", kind: "question", cwd: "/synthetic/project", title: "Synthetic title", text: "Choose a synthetic route?\nChoose synthetic flags?", interactive: true });
    expect(posts[0].body.questionIdentity).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(posts[0].body.questionData).toEqual(syntheticAskQuestions);
    expect(posts[0].url).toBe(process.env.DASH_URL);
    expect(posts[0].options.method).toBe("POST");
    expect(posts[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  test("matching ask tool end answers only the same pending question identity", () => {
    fire("tool_execution_start", { toolName: "ask", toolCallId: "synthetic-call", args: { questions: syntheticAskQuestions } });
    const identity = posts[0].body.questionIdentity;
    posts.length = 0;
    fire("tool_execution_end", { toolName: "ask", toolCallId: "synthetic-call" });
    expect(posts.map((post) => ({ kind: post.body.kind, identity: post.body.questionIdentity }))).toEqual([
      { kind: "question_answered", identity },
    ]);
  });

  test("approval request posts a permission with the tool name", () => {
    fire("tool_approval_requested", { toolName: "synthetic-tool" });
    expect(posts.map((post) => ({ kind: post.body.kind, detail: post.body.detail }))).toEqual([{ kind: "permission", detail: "synthetic-tool" }]);
  });

  test("approval resolution posts question_answered", () => {
    fire("tool_approval_resolved", { toolName: "synthetic-tool" });
    expect(posts.map((post) => post.body.kind)).toEqual(["question_answered"]);
  });

  test("agent_end extracts final assistant text blocks", () => {
    fire("agent_end", { willContinue: false, messages: [
      { role: "assistant", content: [{ type: "text", text: "Synthetic " }, { type: "toolCall", name: "noop" }, { type: "text", text: "response" }] },
    ] });
    expect(posts.map((post) => ({ kind: post.body.kind, text: post.body.text }))).toEqual([{ kind: "response", text: "Synthetic response" }]);
  });

  test("agent_end omits a response when the agent will continue", () => {
    fire("agent_end", { willContinue: true, messages: [{ role: "assistant", content: [{ type: "text", text: "Synthetic response" }] }] });
    expect(posts).toHaveLength(0);
  });

  test("session_stop does not duplicate an agent_end response", () => {
    const assistant = { role: "assistant", content: [{ type: "text", text: "Synthetic response" }] };
    fire("agent_end", { willContinue: false, messages: [assistant] });
    fire("session_stop", { last_assistant_message: assistant });
    expect(posts.map((post) => post.body.kind)).toEqual(["response"]);
  });

  test("fetch failure never escapes an event handler", () => {
    globalThis.fetch = (() => { throw new Error("synthetic fetch failure"); }) as typeof fetch;
    expect(() => fire("session_start")).not.toThrow();
  });

  test("non-interactive context does not post", () => {
    fire("session_start", {}, headlessCtx);
    expect(posts).toHaveLength(0);
  });

  test("headless override posts with interactive false", () => {
    process.env.DASH_ALLOW_HEADLESS = "1";
    fire("session_start", {}, headlessCtx);
    expect(posts.map((post) => ({ kind: post.body.kind, interactive: post.body.interactive }))).toEqual([{ kind: "session_start", interactive: false }]);
  });

  test("chooseDelivery prioritizes approvals, asks, idle, then follow-up", () => {
    expect(chooseDelivery({ idle: true, askPending: true, approvals: 1 })).toBe("defer");
    expect(chooseDelivery({ idle: true, askPending: true, approvals: 0 })).toBe("answer_ask");
    expect(chooseDelivery({ idle: true, askPending: false, approvals: 0 })).toBe("prompt");
    expect(chooseDelivery({ idle: false, askPending: false, approvals: 0 })).toBe("followUp");
  });

  test("idle dashboard reply commits before injection with the source prefix and acknowledges sent", async () => {
    const sends: unknown[][] = [];
    const calls: Array<{ url: string; body?: string; method?: string; headers?: HeadersInit }> = [];
    const sequence: string[] = [];
    let waits = 0;
    process.env.DASH_HOST = "WORKSTATION";
    globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
      const value = String(url);
      calls.push({ url: value, body: typeof options?.body === "string" ? options.body : undefined, method: options?.method, headers: options?.headers });
      if (value.includes("/reply/wait/omp")) {
        waits++;
        return Promise.resolve(waits === 1
          ? Response.json({ id: 7, text: "synthetic owner text", source: "web" })
          : new Response(null, { status: 409 }));
      }
      if (value.includes("/reply/commit")) { sequence.push("commit"); return Promise.resolve(Response.json({ ok: true })); }
      if (value.includes("/reply/ack")) return Promise.resolve(new Response("{}"));
      posts.push({ url: value, body: JSON.parse(String(options?.body)), options: options ?? {} });
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (...args) => { sequence.push("send"); sends.push(args); } });
    fire("session_start", {}, { ...interactiveCtx, isIdle: () => true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sends).toEqual([["[dash] The owner replied from the dashboard:\nsynthetic owner text"]]);
    const commitCall = calls.find((call) => call.url.includes("/reply/commit"));
    expect(commitCall?.method).toBe("POST");
    expect(JSON.parse(commitCall!.body!)).toEqual({ id: 7, waiter: expect.any(String) });
    expect(calls.find((call) => call.url.includes("/reply/wait/omp"))?.url).toContain("commit=1");
    const ack = calls.find((call) => call.url.includes("/reply/ack"));
    expect(JSON.parse(ack!.body!)).toMatchObject({ id: 7, outcome: "sent" });
    expect(posts.at(-1)?.body.host).toBe("WORKSTATION");
    const replyHeaders = calls.filter((call) => call.url.includes("/reply/")).map((call) => call.headers as Record<string, string>);
    expect(replyHeaders.length).toBeGreaterThanOrEqual(3);
    expect(replyHeaders.every((headers) => headers["X-Dash-Host"] === "WORKSTATION")).toBe(true);
    expect(sequence).toEqual(["commit", "send"]);
  });

  test("busy reply uses followUp", async () => {
    const sends: unknown[][] = [];
    let waits = 0;
    globalThis.fetch = ((url: string | URL | Request) => {
      if (String(url).includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 8, text: "synthetic busy reply", source: "telegram" }) : new Response(null, { status: 409 }));
      if (String(url).includes("/reply/commit")) return Promise.resolve(Response.json({ ok: true }));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (...args) => { sends.push(args); } });
    fire("session_start", {}, { ...interactiveCtx, isIdle: () => false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sends).toEqual([["[dash] The owner replied from Telegram:\nsynthetic busy reply", { deliverAs: "followUp" }]]);
  });

  test("ask reply steers before abort, and skips abort after ask ends", async () => {
    const order: string[] = [];
    const sentTexts: string[] = [];
    let waits = 0;
    let pending = true;
    globalThis.fetch = ((url: string | URL | Request) => {
      if (String(url).includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 9, text: "synthetic answer", source: "web" }) : new Response(null, { status: 409 }));
      if (String(url).includes("/reply/commit")) return Promise.resolve(Response.json({ ok: true }));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (text, opts) => { sentTexts.push(text); order.push(`send:${opts?.deliverAs}`); } });
    const ctx = { ...interactiveCtx, hasPendingMessages: () => pending, abort: () => {
      order.push("abort");
      fire("tool_execution_end", { toolName: "ask", toolCallId: "ask-1" }, ctx);
    } };
    fire("session_start", {}, ctx);
    fire("tool_execution_start", { toolName: "ask", toolCallId: "ask-1", args: { question: "synthetic?" } }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(order.slice(0, 2)).toEqual(["send:steer", "abort"]);
    expect(sentTexts[0]).toBe("[dash] The owner replied from the dashboard, answering your pending question:\nsynthetic answer");

    order.length = 0;
    fire("session_shutdown", {}, ctx);
    waits = 0;
    pending = false;
    extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (_text, opts) => {
      order.push(`send:${opts?.deliverAs}`);
      fire("tool_execution_end", { toolName: "ask", toolCallId: "ask-2" }, ctx);
      pending = false;
    } });
    fire("session_start", {}, ctx);
    fire("tool_execution_start", { toolName: "ask", toolCallId: "ask-2" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(order).toEqual(["send:steer"]);
  });

  test("approval pending acknowledges deferred", async () => {
    const calls: string[] = [];
    let waits = 0;
    globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
      const value = String(url);
      if (value.includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 10, text: "synthetic deferred reply", source: "web" }) : new Response(null, { status: 409 }));
      if (value.includes("/reply/commit")) calls.push("commit");
      if (value.includes("/reply/ack")) calls.push(String(options?.body));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: () => {} });
    fire("session_start");
    fire("tool_approval_requested", { toolName: "synthetic-tool" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(calls[0])).toMatchObject({ id: 10, outcome: "deferred" });
    expect(calls).toHaveLength(1);
  });

  test("autopilot uses its exact non-owner prefix", async () => {
    const sends: string[] = [];
    let waits = 0;
    globalThis.fetch = ((url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 12, text: "synthetic recommendation", source: "autopilot" })
        : new Response(null, { status: 409 }));
      if (value.includes("/reply/commit")) return Promise.resolve(Response.json({ ok: true }));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (text) => { sends.push(text); } });
    fire("session_start", {}, { ...interactiveCtx, isIdle: () => true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sends).toEqual(["[dash autopilot, not the owner]:\nsynthetic recommendation"]);
  });

  test("transient commit failures retry, and injection follows a successful commit", async () => {
    const order: string[] = [];
    const commits: string[] = [];
    let waits = 0;
    globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
      const value = String(url);
      if (value.includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 13, text: "synthetic retry", source: "telegram" })
        : new Response(null, { status: 409 }));
      if (value.includes("/reply/commit")) {
        const body = String(options?.body);
        commits.push(body);
        if (commits.length === 1) return Promise.resolve(new Response("{}", { status: 503 }));
        order.push("commit-ok");
        return Promise.resolve(Response.json({ ok: true }));
      }
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: () => { order.push("send"); } });
    fire("session_start", {}, { ...interactiveCtx, isIdle: () => true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(commits).toHaveLength(2);
    expect(JSON.parse(commits[0]!)).toEqual(JSON.parse(commits[1]!));
    expect(order).toEqual(["commit-ok", "send"]);
  });

  test("commit retries stop at the 60-second lease bound without injection", async () => {
    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const start = 10_000;
    let fakeNow = start;
    let waits = 0;
    let commits = 0;
    const sends: unknown[][] = [];
    Date.now = () => fakeNow;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      fakeNow += Number(delay) || 0;
      return originalSetTimeout(callback, 0, ...args);
    }) as typeof setTimeout;
    globalThis.fetch = ((url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 21, text: "synthetic bounded retry", source: "web" })
        : new Response(null, { status: 409 }));
      if (value.includes("/reply/commit")) { commits++; return Promise.resolve(new Response("{}", { status: 503 })); }
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    try {
      extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (...args) => { sends.push(args); } });
      fire("session_start", {}, { ...interactiveCtx, isIdle: () => true });
      for (let i = 0; i < 100 && waits < 2; i++) await new Promise((resolve) => originalSetTimeout(resolve, 0));
      expect(fakeNow - start).toBeGreaterThanOrEqual(60_000);
      expect(fakeNow - start).toBeLessThanOrEqual(60_000);
      expect(commits).toBeGreaterThan(1);
      expect(sends).toEqual([]);
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("a stale or rejected commit discards the payload without injection or ack", async () => {
    const sends: unknown[][] = [];
    const routes: string[] = [];
    let waits = 0;
    globalThis.fetch = ((url: string | URL | Request) => {
      const value = String(url);
      routes.push(value);
      if (value.includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 14, text: "synthetic stale", source: "web" })
        : new Response(null, { status: 409 }));
      if (value.includes("/reply/commit")) return Promise.resolve(new Response('{"error":"not deliverable"}', { status: 409 }));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (...args) => { sends.push(args); } });
    fire("session_start", {}, { ...interactiveCtx, isIdle: () => true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(routes.some((route) => route.includes("/reply/commit"))).toBe(true);
    expect(routes.some((route) => route.includes("/reply/ack"))).toBe(false);
    expect(sends).toEqual([]);
  });

  test("a synchronous send throw reports only omp_send_uncertain and never a deferred ack", async () => {
    const reports: string[] = [];
    const ackBodies: string[] = [];
    let waits = 0;
    const oldError = console.error;
    console.error = (...args: unknown[]) => { reports.push(args.map(String).join(" ")); };
    globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
      const value = String(url);
      if (value.includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 15, text: "synthetic uncertain", source: "web" })
        : new Response(null, { status: 409 }));
      if (value.includes("/reply/commit")) return Promise.resolve(Response.json({ ok: true }));
      if (value.includes("/reply/ack")) ackBodies.push(String(options?.body));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    try {
      extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: () => { throw new Error("synthetic send failure"); } });
      fire("session_start", {}, { ...interactiveCtx, isIdle: () => true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reports).toEqual(["dash omp_send_uncertain"]);
      expect(ackBodies).toEqual([]);
    } finally { console.error = oldError; }
  });

  test("answer_ask without hasPendingMessages aborts a remembered ask", async () => {
    const order: string[] = [];
    const reports: string[] = [];
    let waits = 0;
    const oldError = console.error;
    console.error = (...args: unknown[]) => { reports.push(args.map(String).join(" ")); };
    globalThis.fetch = ((url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 16, text: "synthetic ask response", source: "web" })
        : new Response(null, { status: 409 }));
      if (value.includes("/reply/commit")) return Promise.resolve(Response.json({ ok: true }));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (_text, options) => { order.push(`send:${options?.deliverAs}`); } });
    const ctx = { ...interactiveCtx, abort: () => { order.push("abort"); } };
    fire("session_start", {}, ctx);
    fire("tool_execution_start", { toolName: "ask", toolCallId: "ask-no-api", args: { question: "synthetic?" } }, ctx);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(order.slice(0, 2)).toEqual(["send:steer", "abort"]);
      expect(reports).toEqual(["dash omp_ask_still_pending"]);
    } finally { console.error = oldError; }
  });

  test("answer_ask retains the hasPendingMessages abort gate", async () => {
    const order: string[] = [];
    const reports: string[] = [];
    let waits = 0;
    const oldError = console.error;
    console.error = (...args: unknown[]) => { reports.push(args.map(String).join(" ")); };
    globalThis.fetch = ((url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 17, text: "synthetic ask response", source: "web" })
        : new Response(null, { status: 409 }));
      if (value.includes("/reply/commit")) return Promise.resolve(Response.json({ ok: true }));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    try {
      extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (_text, options) => { order.push(`send:${options?.deliverAs}`); } });
      const ctx = { ...interactiveCtx, hasPendingMessages: () => false, abort: () => { order.push("abort"); } };
      fire("session_start", {}, ctx);
      fire("tool_execution_start", { toolName: "ask", toolCallId: "ask-gated", args: { question: "synthetic?" } }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(order).toEqual(["send:steer"]);
      expect(reports).toEqual(["dash omp_ask_still_pending"]);
    } finally { console.error = oldError; }
  });

  test("answer_ask reports safe codes when abort is absent or throws", async () => {
    for (const mode of ["absent", "throws"] as const) {
      const reports: string[] = [];
      let waits = 0;
      const oldError = console.error;
      console.error = (...args: unknown[]) => { reports.push(args.map(String).join(" ")); };
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
          ? Response.json({ id: 18, text: "synthetic ask response", source: "web" })
          : new Response(null, { status: 409 }));
        if (value.includes("/reply/commit")) return Promise.resolve(Response.json({ ok: true }));
        return Promise.resolve(new Response("{}"));
      }) as typeof fetch;
      try {
        const ctx: Record<string, unknown> = { ...interactiveCtx };
        if (mode === "throws") ctx.abort = () => { throw new Error("synthetic abort failure"); };
        extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: () => {} });
        fire("session_start", {}, ctx);
        fire("tool_execution_start", { toolName: "ask", toolCallId: `ask-${mode}`, args: { question: "synthetic?" } }, ctx);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(reports).toEqual([`dash omp_ask_abort_${mode === "absent" ? "unavailable" : "failed"}`]);
      } finally {
        console.error = oldError;
        handlers.get("session_shutdown")?.({}, interactiveCtx);
      }
    }
  });

  test("approval appearing during steer is reported locally without a deferred ack", async () => {
    const reports: string[] = [];
    const ackBodies: Array<Record<string, unknown>> = [];
    const order: string[] = [];
    let waits = 0;
    const oldError = console.error;
    console.error = (...args: unknown[]) => { reports.push(args.map(String).join(" ")); };
    globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
      const value = String(url);
      if (value.includes("/reply/wait/omp")) return Promise.resolve(++waits === 1
        ? Response.json({ id: 19, text: "synthetic ask response", source: "web" })
        : new Response(null, { status: 409 }));
      if (value.includes("/reply/commit")) return Promise.resolve(Response.json({ ok: true }));
      if (value.includes("/reply/ack")) ackBodies.push(JSON.parse(String(options?.body)));
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    try {
      const ctx = { ...interactiveCtx, hasPendingMessages: () => false };
      extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: (_text, options) => {
        order.push(`send:${options?.deliverAs}`);
        fire("tool_approval_requested", { toolName: "synthetic-tool" }, ctx);
      } });
      fire("session_start", {}, ctx);
      fire("tool_execution_start", { toolName: "ask", toolCallId: "ask-late-approval", args: { question: "synthetic?" } }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(order).toEqual(["send:steer"]);
      expect(reports).toContain("dash omp_approval_after_commit");
      expect(ackBodies).toHaveLength(1);
      expect(ackBodies[0]).toMatchObject({ id: 19, outcome: "sent" });
      expect(ackBodies.some((ack) => ack.outcome === "deferred")).toBe(false);
    } finally { console.error = oldError; }
  });

  test("404 backs off for 300 seconds and 409 stops polling", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      delays.push(Number(delay));
      return originalSetTimeout(callback, 60_000, ...args);
    }) as typeof setTimeout;
    let waits = 0;
    globalThis.fetch = ((url: string | URL | Request) => {
      if (String(url).includes("/reply/wait/omp")) {
        waits++;
        return Promise.resolve(new Response(null, { status: waits === 1 ? 404 : 409 }));
      }
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    try {
      extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: () => {} });
      fire("session_start");
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
      expect(delays).toContain(300_000);
      fire("session_shutdown");
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
      expect(waits).toBe(1);

      waits = 0;
      extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: () => {} });
      fire("session_start");
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
      expect(waits).toBe(1);
      fire("session_shutdown");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("shutdown aborts the in-flight reply fetch and non-TUI starts no loop", async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
      if (String(url).includes("/reply/wait/omp")) {
        signal = options?.signal as AbortSignal;
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      }
      posts.push({ url: String(url), body: JSON.parse(String(options?.body)), options: options ?? {} });
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    extension({ on: (name, handler) => handlers.set(name, handler), sendUserMessage: () => {} });
    fire("session_start", {}, headlessCtx);
    expect(signal).toBeUndefined();
    fire("session_start");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signal).toBeDefined();
    fire("session_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signal?.aborted).toBe(true);
  });
});

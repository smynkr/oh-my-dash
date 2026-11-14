import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgyTranscript, scanAgyBackfill, scanBackfill } from "../src/backfill.ts";
import { parseAgyAgents, pollAgySessions } from "../src/liveness.ts";
import { localHost, describePrompt, normalizeAgy, normalizeAgyQuestions, stripAgyPromptEnvelope } from "../src/normalize.ts";
import { createDashServer } from "../src/server.ts";
import { installAgyPlugin, parseArgs as parseAgyInstallArgs } from "../scripts/install-agy-plugin.ts";

const hookScript = join(import.meta.dir, "../agy-plugin/dash-agy-hook.py");

function createSummaryDb(root: string, rows: Array<{
  id: string;
  title?: string;
  workspaces?: string[];
  modified?: string;
  killed?: number;
  nestingDepth?: number;
  parentId?: string;
}>) {
  const dbPath = join(root, "conversation_summaries.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      workspace_uris TEXT,
      last_modified_time TEXT,
      status TEXT DEFAULT 'IDLE',
      not_fully_idle INTEGER DEFAULT 0,
      killed INTEGER DEFAULT 0,
      nesting_depth INTEGER DEFAULT 0,
      parent_conversation_id TEXT DEFAULT ''
    );
  `);
  const stmt = sqlite.query(`
    INSERT INTO conversation_summaries (
      conversation_id, title, workspace_uris, last_modified_time, killed, nesting_depth, parent_conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    stmt.run(
      row.id,
      row.title ?? "Synthetic conversation",
      JSON.stringify(row.workspaces ?? ["file:///work/synthetic-repo"]),
      row.modified ?? "2026-11-14 03:27:24.475484+00:00",
      row.killed ?? 0,
      row.nestingDepth ?? 0,
      row.parentId ?? "",
    );
  }
  sqlite.close();
}

function writeTranscript(root: string, id: string, compactRows: unknown[], fullRows?: unknown[]): string {
  const logDir = join(root, "brain", id, ".system_generated", "logs");
  mkdirSync(logDir, { recursive: true });
  const compactPath = join(logDir, "transcript.jsonl");
  writeFileSync(compactPath, compactRows.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
  if (fullRows) {
    writeFileSync(join(logDir, "transcript_full.jsonl"), fullRows.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  return compactPath;
}

describe("Antigravity normalization", () => {
  test("strips context summary and unwraps <USER_REQUEST> envelopes", () => {
    const raw = `<CONTEXT_SUMMARY>\nOld summary text\n</CONTEXT_SUMMARY>\n<USER_REQUEST>\nAdd first-class Antigravity support\n</USER_REQUEST>`;
    expect(stripAgyPromptEnvelope(raw)).toBe("Add first-class Antigravity support");
    // describePrompt remains harness-agnostic so literal tags in non-agy prompts are preserved.
    expect(describePrompt("Literal doc snippet: <USER_REQUEST>example</USER_REQUEST>")).toBe(
      "Literal doc snippet: <USER_REQUEST>example</USER_REQUEST>",
    );

    const event = normalizeAgy(
      {
        hookEventName: "PreInvocation",
        conversationId: "conv-1",
        workspacePaths: ["file:///work/synthetic-repo"],
        userPrompt: raw,
      },
      new Headers({
        "X-Dash-Host": "synthetic-host",
        "X-Dash-Account-Alias": "work",
      }),
    );
    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      host: "synthetic-host",
      harness: "agy",
      sessionId: "conv-1",
      cwd: "/work/synthetic-repo",
      accountAlias: "work",
      kind: "prompt",
      text: "Add first-class Antigravity support",
      interactive: true,
    });
  });

  test("normalizes ask_question string options, Recommended prefixes, and multi-select", () => {
    const normalized = normalizeAgyQuestions([
      {
        question: "Which transport should we use?",
        options: ["(Recommended) Native hooks", "Polling bridge"],
      },
      {
        question: "Select target surfaces",
        options: ["Web Console", "Telegram", "CLI"],
        is_multi_select: true,
      },
    ]);
    expect(normalized).toEqual([
      {
        id: "0",
        question: "Which transport should we use?",
        options: [{ label: "Native hooks" }, { label: "Polling bridge" }],
        recommended: 0,
      },
      {
        id: "1",
        question: "Select target surfaces",
        options: [{ label: "Web Console" }, { label: "Telegram" }, { label: "CLI" }],
        multi: true,
      },
    ]);
  });

  test("normalizes PreToolUse, PostToolUse, and Stop lifecycle payloads", () => {
    const hdrs = new Headers({ "X-Dash-Host": "synthetic-host" });
    const askEvent = normalizeAgy(
      {
        hookEventName: "PreToolUse",
        conversationId: "conv-2",
        cwd: "/work/synthetic-repo",
        toolCall: {
          name: "ask_question",
          args: { questions: [{ question: "Proceed with migration?", options: ["Yes", "No"] }] },
        },
      },
      hdrs,
    );
    expect(askEvent).toMatchObject({
      host: "synthetic-host",
      harness: "agy",
      sessionId: "conv-2",
      kind: "question",
      text: "Proceed with migration?",
    });

    const postEvent = normalizeAgy(
      {
        hookEventName: "PostToolUse",
        conversationId: "conv-2",
        toolCall: { name: "ask_question" },
      },
      hdrs,
    );
    expect(postEvent).toMatchObject({
      host: "synthetic-host",
      harness: "agy",
      sessionId: "conv-2",
      kind: "question_answered",
    });

    const stopEvent = normalizeAgy(
      {
        hookEventName: "Stop",
        conversationId: "conv-2",
        terminationReason: "NO_TOOL_CALL",
        last_assistant_message: "Migration completed cleanly.",
      },
      hdrs,
    );
    expect(stopEvent).toMatchObject({
      host: "synthetic-host",
      harness: "agy",
      sessionId: "conv-2",
      kind: "response",
      text: "Migration completed cleanly.",
    });

    const canceledStop = normalizeAgy(
      {
        hookEventName: "Stop",
        conversationId: "conv-2",
        terminationReason: "USER_CANCELED",
        last_assistant_message: "Partial canceled text that should not be stored.",
      },
      hdrs,
    );
    expect(canceledStop?.kind).toBe("response");
    expect(canceledStop?.text).toBeUndefined();
  });
});

describe("Antigravity backfill and presence lock liveness", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "dash-agy-test-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("resolves truncated transcript_full.jsonl responses and excludes subagents or killed sessions", async () => {
    const agyRoot = join(scratch, "antigravity-cli");
    mkdirSync(agyRoot, { recursive: true });
    createSummaryDb(agyRoot, [
      { id: "main-conv", title: "Primary AGY Session", workspaces: ["file:///work/synthetic-alpha"] },
      { id: "../escaped-conv", title: "Traversal Attempt", workspaces: ["file:///work/escaped"] },
      { id: "subagent-conv", title: "Subagent Worker", nestingDepth: 1, parentId: "main-conv" },
      { id: "killed-conv", title: "Killed Session", killed: 1 },
    ]);
    writeTranscript(scratch, "escaped-conv", [
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>\nEscaped\n</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", content: "Should never be read" },
    ]);

    const compactPath = writeTranscript(
      agyRoot,
      "main-conv",
      [
        {
          step_index: 0,
          type: "USER_INPUT",
          source: "USER_EXPLICIT",
          created_at: "2026-11-14T01:00:00Z",
          content: "<USER_REQUEST>\nInspect repository layout\n</USER_REQUEST>",
        },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-14T01:00:05Z",
          content: "Truncated preview...",
          truncated_fields: ["content"],
        },
      ],
      [
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: "2026-11-14T01:00:05Z",
          content: "Full planner response resolved from transcript_full.jsonl.",
        },
      ],
    );
    writeTranscript(agyRoot, "subagent-conv", [
      { step_index: 0, type: "PLANNER_RESPONSE", created_at: "2026-11-14T01:01:00Z", content: "Subagent output" },
    ]);
    writeTranscript(agyRoot, "killed-conv", [
      { step_index: 0, type: "PLANNER_RESPONSE", created_at: "2026-11-14T01:02:00Z", content: "Killed output" },
    ]);

    const parsed = parseAgyTranscript(compactPath, {
      sessionId: "main-conv",
      host: "synthetic-host",
      title: "Primary AGY Session",
      cwd: "/work/synthetic-alpha",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.responses[0]?.prompt).toBe("Inspect repository layout");
    expect(parsed?.responses[0]?.text).toBe("Full planner response resolved from transcript_full.jsonl.");

    const scanned = await scanAgyBackfill(0, [agyRoot]);
    expect(scanned.map(s => s.sessionId)).toEqual(["main-conv"]);
    expect(scanned[0]).toMatchObject({
      harness: "agy",
      title: "Primary AGY Session",
      cwd: "/work/synthetic-alpha",
    });

    // Passing custom Claude roots without agyRoots keeps scanBackfill hermetic.
    const emptyClaude = join(scratch, "empty-claude");
    mkdirSync(emptyClaude, { recursive: true });
    expect(await scanBackfill(12, { roots: [{ path: emptyClaude, omp: false }] })).toEqual([]);

    // Without conversation_summaries.db, directory fallback still skips subagent transcripts lacking <USER_REQUEST>.
    const dbLessRoot = join(scratch, "antigravity-no-db");
    writeTranscript(dbLessRoot, "main-nodb", [
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", created_at: "2026-11-14T01:00:00Z", content: "<USER_REQUEST>\nDirect user prompt\n</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-14T01:00:05Z", content: "Main reply" },
    ]);
    writeTranscript(dbLessRoot, "worker-nodb", [
      { step_index: 0, type: "USER_INPUT", source: "AGENT", created_at: "2026-11-14T01:00:00Z", content: "Subagent brief without envelope" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: "2026-11-14T01:00:05Z", content: "Subagent reply" },
    ]);
    const dbLessScanned = await scanAgyBackfill(0, [dbLessRoot]);
    expect(dbLessScanned.map(s => s.sessionId)).toEqual(["main-nodb"]);
  });

  test("pollAgySessions detects live flock holders and ignores stale or subagent locks", async () => {
    const agyRoot = join(scratch, "antigravity-cli");
    const presenceDir = join(agyRoot, "presence");
    mkdirSync(presenceDir, { recursive: true });
    createSummaryDb(agyRoot, [
      { id: "live-conv", title: "Live Antigravity", workspaces: ["file:///work/live-project"] },
      { id: "stale-conv", title: "Exited Antigravity", workspaces: ["file:///work/stale-project"] },
      { id: "child-conv", title: "Subagent Lock", nestingDepth: 1, parentId: "live-conv" },
    ]);

    const liveLock = join(presenceDir, "live-conv.lock");
    const staleLock = join(presenceDir, "stale-conv.lock");
    const childLock = join(presenceDir, "child-conv.lock");
    writeFileSync(liveLock, "");
    writeFileSync(staleLock, "");
    writeFileSync(childLock, "");

    const holder = Bun.spawn([
      "python3",
      "-c",
      `
import fcntl, os, sys, time
fd1 = os.open(sys.argv[1], os.O_RDWR)
fd2 = os.open(sys.argv[2], os.O_RDWR)
fcntl.flock(fd1, fcntl.LOCK_EX)
fcntl.flock(fd2, fcntl.LOCK_EX)
sys.stdout.write("locked\\n")
sys.stdout.flush()
time.sleep(10)
      `,
      liveLock,
      childLock,
    ], { stdout: "pipe", stderr: "pipe" });

    try {
      const reader = holder.stdout.getReader();
      const firstChunk = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(firstChunk.value)).toContain("locked");

      const live = await pollAgySessions({ roots: [agyRoot], host: "synthetic-host" });
      expect(live).toEqual([
        {
          host: "synthetic-host",
          harness: "agy",
          sessionId: "live-conv",
          cwd: "/work/live-project",
          name: "Live Antigravity",
          detail: "IDLE",
        },
      ]);
    } finally {
      holder.kill();
      await holder.exited;
    }

    expect(
      parseAgyAgents(
        {
          agents: [{ sessionId: "live-conv", cwd: "file:///work/live-project", name: "Live" }],
        },
        "synthetic-host",
      ),
    ).toEqual([
      {
        host: "synthetic-host",
        harness: "agy",
        sessionId: "live-conv",
        cwd: "/work/live-project",
        name: "Live",
      },
    ]);

    // A missing or failing Python probe returns null (unknown), never an empty authoritative list.
    expect(await pollAgySessions({ roots: [agyRoot], host: "synthetic-host", pythonBin: "/synthetic/nonexistent-python3" })).toBeNull();
  });
});

describe("Antigravity hook, replies, and remote ask_question integration", () => {
  let scratch: string;
  let originalEnv: Record<string, string | undefined>;
  let app: ReturnType<typeof createDashServer> | null = null;
  const envKeys = ["DASH_REPLIES", "DASH_CLAUDE_QUESTIONS", "DASH_AGY_HOME", "DASH_TAILNET_PORT", "DASH_TELEGRAM", "DASH_JUDGE"];

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "dash-agy-server-"));
    originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
    process.env.DASH_REPLIES = "1";
    process.env.DASH_CLAUDE_QUESTIONS = "1";
    process.env.DASH_TAILNET_PORT = "";
    process.env.DASH_TELEGRAM = "";
    process.env.DASH_JUDGE = "";
  });

  afterEach(() => {
    app?.close();
    app = null;
    rmSync(scratch, { recursive: true, force: true });
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function invokeAgyHook(baseUrl: string, agyRoot: string, payload: unknown, extraArgs: string[] = []) {
    const proc = Bun.spawn(
      [
        "python3",
        hookScript,
        "--url",
        `${baseUrl}/ingest/agy`,
        "--reply-base",
        baseUrl,
        "--account",
        "personal",
        ...extraArgs,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, DASH_AGY_HOME: agyRoot },
      },
    );
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr };
  }

  test("SessionStart, PreInvocation reply injection, Stop continuation, and liveness sweep", async () => {
    const agyRoot = join(scratch, "agy-home");
    mkdirSync(agyRoot, { recursive: true });
    createSummaryDb(agyRoot, [{ id: "conv-live", title: "AGY Feature Build", workspaces: ["file:///work/synthetic-dash"] }]);
    const transcriptPath = writeTranscript(
      agyRoot,
      "conv-live",
      [
        { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>\nBuild AGY bridge\n</USER_REQUEST>" },
        { step_index: 1, type: "PLANNER_RESPONSE", content: "Short...", truncated_fields: ["content"] },
      ],
      [
        { step_index: 1, type: "PLANNER_RESPONSE", content: "Implemented the full Antigravity bridge and verified hooks." },
      ],
    );

    let clock = Date.now();
    let agyPollResult: [] | null = [];
    app = createDashServer({
      port: 0,
      hostname: "127.0.0.1",
      dataPath: join(scratch, "dash.sqlite"),
      backfill: false,
      liveness: false,
      now: () => clock,
      pollClaude: async () => [],
      pollOmp: async () => [],
      pollAgy: async () => agyPollResult,
    });
    const baseUrl = `http://127.0.0.1:${app.server.port}`;
    const host = localHost();
    const key = `${host}|agy|conv-live`;

    const startRes = await invokeAgyHook(baseUrl, agyRoot, {
      hookEventName: "SessionStart",
      conversationId: "conv-live",
      workspacePaths: ["file:///work/synthetic-dash"],
      transcriptPath,
    });
    expect(startRes.exitCode).toBe(0);
    expect(JSON.parse(startRes.stdout)).toEqual({});

    let sessions = (await (await fetch(`${baseUrl}/api/sessions`)).json() as any).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      key,
      harness: "agy",
      title: "AGY Feature Build",
      cwd: "/work/synthetic-dash",
      accountAlias: "personal",
      status: "your_turn",
    });

    // Verify PreInvocation extracts the latest user prompt from transcriptPath when stdin omits userPrompt.
    const plainPreInv = await invokeAgyHook(baseUrl, agyRoot, {
      hookEventName: "PreInvocation",
      conversationId: "conv-live",
      invocationNum: 1,
      transcriptPath,
    });
    expect(plainPreInv.exitCode).toBe(0);
    expect(app.db.getSession(key)?.lastPrompt).toBe("Build AGY bridge");

    // Return session to your_turn so a reply can be queued and injected on the next PreInvocation.
    await invokeAgyHook(baseUrl, agyRoot, {
      hookEventName: "Stop",
      conversationId: "conv-live",
      terminationReason: "USER_CANCELED",
      last_assistant_message: "Canceled partial output",
    });
    expect(app.db.getSession(key)?.status).toBe("your_turn");
    expect(app.db.getSession(key)?.lastResponses).toEqual([]);

    // Queue a reply and verify PreInvocation injects it via injectSteps.
    const q1 = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(key)}/reply`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Please also run unit tests." }),
    });
    expect(q1.status).toBe(200);

    const preInv = await invokeAgyHook(baseUrl, agyRoot, {
      hookEventName: "PreInvocation",
      conversationId: "conv-live",
      invocationNum: 1,
      transcriptPath,
    });
    expect(preInv.exitCode).toBe(0);
    const preInvJson = JSON.parse(preInv.stdout);
    expect(preInvJson.injectSteps?.[0]?.userMessage).toContain("Please also run unit tests.");
    expect(app.db.getReplies(key)[0]?.state).toBe("delivered");
    expect(app.db.getSession(key)?.lastPrompt).toBe("(reply via web)");

    // Queue a second reply and verify Stop extracts full transcript response and returns decision: continue.
    const q2 = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(key)}/reply`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Now summarize the diff." }),
    });
    expect(q2.status).toBe(200);

    const stopRes = await invokeAgyHook(
      baseUrl,
      agyRoot,
      {
        hookEventName: "Stop",
        conversationId: "conv-live",
        terminationReason: "NO_TOOL_CALL",
        transcriptPath,
      },
      ["--stop-wait", "2"],
    );
    expect(stopRes.exitCode).toBe(0);
    const stopJson = JSON.parse(stopRes.stdout);
    expect(stopJson.decision).toBe("continue");
    expect(stopJson.reason).toContain("Now summarize the diff.");

    sessions = (await (await fetch(`${baseUrl}/api/sessions`)).json() as any).sessions;
    expect(sessions[0].lastResponses[0]?.text).toBe("Implemented the full Antigravity bridge and verified hooks.");

    // Unknown liveness (pollAgy returning null) never marks a session missing or ended.
    agyPollResult = null;
    await app.runLiveness();
    expect(app.db.isConfirmedMissingSession(key)).toBe(false);
    clock += 121_000;
    await app.runLiveness();
    expect(app.db.getSession(key)?.status).toBe("working");

    // Local liveness sweep records dead_since on first authoritative miss, then marks ended after 120s grace.
    agyPollResult = [];
    await app.runLiveness();
    expect(app.db.isConfirmedMissingSession(key)).toBe(true);
    clock += 121_000;
    await app.runLiveness();
    sessions = (await (await fetch(`${baseUrl}/api/sessions?ended=1`)).json() as any).sessions;
    expect(sessions.find((s: any) => s.key === key)?.status).toBe("ended");

    // Remote liveness ingest marks absent remote AGY sessions as ended after 120s grace.
    await fetch(`${baseUrl}/ingest/agy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dash-Host": "remote-box" },
      body: JSON.stringify({
        hookEventName: "SessionStart",
        conversationId: "conv-remote",
        cwd: "/work/remote-repo",
      }),
    });
    const liveResp1 = await fetch(`${baseUrl}/ingest/liveness/agy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dash-Host": "remote-box" },
      body: JSON.stringify({ agents: [] }),
    });
    expect(liveResp1.status).toBe(200);
    expect(app.db.isConfirmedMissingSession("remote-box|agy|conv-remote")).toBe(true);
    clock += 121_000;
    const liveResp2 = await fetch(`${baseUrl}/ingest/liveness/agy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dash-Host": "remote-box" },
      body: JSON.stringify({ agents: [] }),
    });
    expect(liveResp2.status).toBe(200);
    sessions = (await (await fetch(`${baseUrl}/api/sessions?ended=1`)).json() as any).sessions;
    expect(sessions.find((s: any) => s.key === "remote-box|agy|conv-remote")?.status).toBe("ended");
  });

  test("PreToolUse ask_question answers remotely via deny-reason and supports release to terminal", async () => {
    const agyRoot = join(scratch, "agy-home");
    mkdirSync(agyRoot, { recursive: true });
    createSummaryDb(agyRoot, [{ id: "conv-q", title: "AGY Question Flow", workspaces: ["file:///work/synthetic-dash"] }]);

    app = createDashServer({
      port: 0,
      hostname: "127.0.0.1",
      dataPath: join(scratch, "dash.sqlite"),
      backfill: false,
      liveness: false,
    });
    const baseUrl = `http://127.0.0.1:${app.server.port}`;
    const key = `${localHost()}|agy|conv-q`;

    const askPayload = {
      hookEventName: "PreToolUse",
      conversationId: "conv-q",
      workspacePaths: ["file:///work/synthetic-dash"],
      toolCall: {
        id: "call_ask_1",
        name: "ask_question",
        args: {
          questions: [
            {
              question: "Which database mode should we enable?",
              options: ["(Recommended) WAL mode", "Journal mode"],
            },
          ],
        },
      },
    };

    const pendingHook = invokeAgyHook(baseUrl, agyRoot, askPayload, ["--remote-questions", "--question-timeout-ms", "5000"]);

    let pendingQuestionId = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      const list = (await (await fetch(`${baseUrl}/api/sessions`)).json() as any).sessions;
      const found = list.find((s: any) => s.key === key);
      if (found?.pendingQuestion?.id) {
        pendingQuestionId = found.pendingQuestion.id;
        expect(found.pendingQuestion.questions[0]).toMatchObject({
          question: "Which database mode should we enable?",
          options: [{ label: "WAL mode" }, { label: "Journal mode" }],
          recommended: 0,
        });
        break;
      }
      await Bun.sleep(40);
    }
    expect(pendingQuestionId).not.toBe("");

    const answerRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(key)}/question`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({
        questionId: pendingQuestionId,
        answers: {
          "Which database mode should we enable?": { selectedOptions: [0] },
        },
      }),
    });
    expect(answerRes.status).toBe(200);

    const hookDone = await pendingHook;
    expect(hookDone.exitCode).toBe(0);
    const decision = JSON.parse(hookDone.stdout);
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("Which database mode should we enable?: WAL mode");

    // Now test releasing a second question to the terminal -> hook returns {"decision":"allow"}.
    const secondPayload = {
      ...askPayload,
      toolCall: { ...askPayload.toolCall, id: "call_ask_2" },
    };
    const secondHook = invokeAgyHook(baseUrl, agyRoot, secondPayload, ["--remote-questions", "--question-timeout-ms", "5000"]);
    let secondQid = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      const list = (await (await fetch(`${baseUrl}/api/sessions`)).json() as any).sessions;
      const found = list.find((s: any) => s.key === key);
      if (found?.pendingQuestion?.id && found.pendingQuestion.id !== pendingQuestionId) {
        secondQid = found.pendingQuestion.id;
        break;
      }
      await Bun.sleep(40);
    }
    expect(secondQid).not.toBe("");

    const releaseRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(key)}/question/release`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: secondQid }),
    });
    expect(releaseRes.status).toBe(200);

    const releasedHook = await secondHook;
    expect(releasedHook.exitCode).toBe(0);
    expect(JSON.parse(releasedHook.stdout)).toEqual({ decision: "allow" });
  });
});

describe("Antigravity plugin installer", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "dash-agy-installer-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("installs scoped ask_question hooks, refuses unmanaged directories or symlinks, and uninstalls cleanly", async () => {
    const target = join(scratch, "plugins", "dash");
    const dryArgs = parseAgyInstallArgs([
      "--target",
      target,
      "--url",
      "http://127.0.0.1:4777/ingest/agy",
      "--host",
      "synthetic-host",
      "--account",
      "work",
      "--remote-questions",
      "--stop-wait",
      "8",
      "--dry-run",
    ]);
    const dryOut = await installAgyPlugin(dryArgs);
    expect(dryOut).toContain("Would install");
    expect(() => lstatSync(target)).toThrow();

    await installAgyPlugin({ ...dryArgs, dryRun: false });
    const hooksDoc = JSON.parse(readFileSync(join(target, "hooks.json"), "utf8"));
    expect(hooksDoc.dash.PreToolUse).toEqual([
      {
        matcher: "ask_question",
        hooks: [{ type: "command", command: "python3 ./dash-agy-hook.py", timeout: 125 }],
      },
    ]);
    expect(hooksDoc.dash.PostToolUse).toEqual([
      {
        matcher: "ask_question",
        hooks: [{ type: "command", command: "python3 ./dash-agy-hook.py", timeout: 10 }],
      },
    ]);
    const cfgDoc = JSON.parse(readFileSync(join(target, "dash-config.json"), "utf8"));
    expect(cfgDoc).toMatchObject({
      url: "http://127.0.0.1:4777/ingest/agy",
      replyBase: "http://127.0.0.1:4777",
      host: "synthetic-host",
      account: "work",
      remoteQuestions: true,
      stopWaitSec: 8,
    });
    expect(lstatSync(join(target, "dash-agy-hook.py")).mode & 0o111).toBeGreaterThan(0);

    // Uninstall removes managed plugin cleanly.
    await installAgyPlugin(parseAgyInstallArgs(["--target", target, "--uninstall"]));
    expect(() => lstatSync(target)).toThrow();

    // Unmanaged non-empty directory is refused by both install and uninstall.
    const unmanaged = join(scratch, "unmanaged");
    mkdirSync(unmanaged, { recursive: true });
    writeFileSync(join(unmanaged, "custom.txt"), "keep me");
    await expect(installAgyPlugin(parseAgyInstallArgs(["--target", unmanaged]))).rejects.toThrow("unmanaged");
    await expect(installAgyPlugin(parseAgyInstallArgs(["--target", unmanaged, "--uninstall"]))).rejects.toThrow("unmanaged");

    // Symlink target is refused.
    const realDir = join(scratch, "real-dir");
    const linkDir = join(scratch, "link-dir");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, linkDir);
    await expect(installAgyPlugin(parseAgyInstallArgs(["--target", linkDir]))).rejects.toThrow("symlink");
  });
});

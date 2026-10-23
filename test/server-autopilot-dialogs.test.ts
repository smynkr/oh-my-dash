import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDashServer } from "../src/server.ts";
import { AutopilotStore } from "../src/autopilot-store.ts";
import { localHost } from "../src/normalize.ts";

const envNames = ["DASH_REPLIES", "DASH_AUTOPILOT", "DASH_DIALOGS", "DASH_DIALOGS_E3_PASS", "DASH_DIALOGS_E4_PASS",
  "DASH_DIALOGS_E5_MAX_HOLD_MS", "DASH_ASK_HOLD_MIN", "DASH_JUDGE", "DASH_CODEX_BIN"] as const;
let previous: Record<string, string | undefined> = {};
let app: ReturnType<typeof createDashServer> | undefined;
let now = 1_000_000;
const sessionId = "synthetic-dialog-session";
const invocationId = "A".repeat(43);
const toolUseId = "tool-use-1";

beforeEach(() => {
  previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  now = 1_000_000;
});

afterEach(() => {
  app?.close();
  app = undefined;
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function start() {
  app = createDashServer({ port: 0, dataPath: ":memory:", backfill: false, liveness: false, now: () => now });
  const base = `http://127.0.0.1:${app.server.port}`;
  const session = app.db.applyEvent({ host: localHost(), harness: "claude", sessionId,
    kind: "session_start", ts: now, interactive: true });
  return { base, session };
}

const cliJson = (base: string, body: unknown) => fetch(`${base}/hook/ask`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Dash-Entrypoint": "cli" },
  body: JSON.stringify(body),
});
const ownerJson = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, {
  method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const askBody = (deadline = now + 60_000) => ({
  toolName: "AskUserQuestion", sessionId, toolUseId, invocationId, hook_deadline_ms: deadline,
  questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], recommended: 1 }],
});

test("dialog hook registration preserves multi-select semantics", async () => {
  process.env.DASH_REPLIES = "1";
  const { base, session } = start();
  const response = await cliJson(base, { ...askBody(), questions: [
    { question: "Which checks?", multiSelect: true, options: [{ label: "Build" }, { label: "Review" }] },
  ] });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ action: "release" });
  expect(app!.db.getQuestionInvocation(invocationId, session.key, toolUseId)?.questions)
    .toMatchObject([{ question: "Which checks?", multi: true }]);
});

test("autopilot and dialog flags default off and the hook releases to native Claude", async () => {
  process.env.DASH_REPLIES = "1";
  const { base, session } = start();
  const health = await (await fetch(`${base}/healthz`)).json() as { autopilot: Record<string, unknown> };
  expect(health.autopilot).toMatchObject({ flagEnabled: false, masterEnabled: false, dialogsFlagEnabled: false });
  expect((await cliJson(base, { ...askBody(), toolName: "Bash" })).status).toBe(400);
  const response = await cliJson(base, askBody());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ action: "release" });
  const malformedFence = await fetch(`${base}/hook/fence`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Dash-Entrypoint": "cli",
  }, body: JSON.stringify({ harness: "claude", sessionId, tool: "ExitPlanMode", input: null }) });
  expect(malformedFence.status).toBe(400);
  const fence = await fetch(`${base}/hook/fence`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Dash-Entrypoint": "cli",
  }, body: JSON.stringify({ harness: "claude", sessionId, tool: "Bash", input: { command: "echo safe" } }) });
  expect(await fence.json()).toMatchObject({ active_goal: false, goal_id: null });
  await fetch(`${base}/question/cancel?session=${sessionId}&toolUseId=${toolUseId}&question=${invocationId}`, {
    method: "DELETE", headers: { "X-Dash-Entrypoint": "cli" },
  });
  expect(app!.db.getSession(session.key)?.status).toBe("needs_input");
});

test("deny fence returns active goal TTL and denies sensitive MCP tools", async () => {
  process.env.DASH_REPLIES = "1";
  process.env.DASH_AUTOPILOT = "1";
  const { base, session } = start();
  expect((await ownerJson(base, "/api/autopilot", { enabled:true })).status).toBe(200);
  expect((await ownerJson(base, `/api/sessions/${encodeURIComponent(session.key)}/autopilot`, {
    action:"create",goalText:"Complete a bounded synthetic task",delayMin:0,
  })).status).toBe(201);
  const response = await fetch(`${base}/hook/fence`, { method:"POST",headers:{
    "Content-Type":"application/json","X-Dash-Entrypoint":"cli",
  },body:JSON.stringify({ harness:"claude",sessionId,tool:"mcp__stripe.create_payment",input:{amount:10} }) });
  expect(response.status).toBe(200);
  const fence = await response.json() as Record<string,unknown>;
  expect(fence).toMatchObject({ active_goal:true,goal_id:1,permissionDecision:"deny" });
  expect(fence.expires_at).toBeGreaterThan(now);
  expect(fence.remaining_ttl_ms).toBeGreaterThan(0);
});

test("E3-E5-gated hook answers only the indexed recommendation through the audited reply path", async () => {
  Object.assign(process.env, {
    DASH_REPLIES: "1", DASH_AUTOPILOT: "1", DASH_DIALOGS: "1", DASH_DIALOGS_E3_PASS: "1",
    DASH_DIALOGS_E4_PASS: "1", DASH_DIALOGS_E5_MAX_HOLD_MS: "600000",
  });
  const { base, session } = start();
  expect((await ownerJson(base, "/api/autopilot", { enabled: true })).status).toBe(200);
  const goalResponse = await ownerJson(base, `/api/sessions/${encodeURIComponent(session.key)}/autopilot`, {
    action: "create", goalText: "Use the recommended database", delayMin: 0,
  });
  expect(goalResponse.status).toBe(201);
  const response = await cliJson(base, askBody());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ action: "answer", source: "autopilot", answers: { "Which database?": "SQLite" },
    autopilot: { goal_id: 1 } });
  const invocation = app!.db.getQuestionInvocation(invocationId, session.key, toolUseId);
  expect(invocation?.state).toBe("consumed");
  expect(app!.db.sqlite.query("SELECT COUNT(*) AS count FROM autopilot_turn_events WHERE goal_id=1 AND event_kind='dialog'").get())
    .toEqual({ count:1 });
  expect(app!.db.sqlite.query("SELECT turns_used FROM autopilot_goals WHERE id=1").get()).toEqual({ turns_used:1 });
  expect(app!.db.getSession(session.key)?.status).toBe("working");
});
test("records elapsed time for an owner answer to a held question", async () => {
  Object.assign(process.env, {
    DASH_REPLIES:"1",DASH_AUTOPILOT:"1",DASH_DIALOGS:"1",DASH_DIALOGS_E3_PASS:"1",
    DASH_DIALOGS_E4_PASS:"1",DASH_DIALOGS_E5_MAX_HOLD_MS:"600000",
  });
  const {base,session} = start();
  expect((await ownerJson(base,"/api/autopilot",{enabled:true,away:true})).status).toBe(200);
  expect((await ownerJson(base,`/api/sessions/${encodeURIComponent(session.key)}/autopilot`,{
    action:"create",goalText:"Wait for the owner",delayMin:0,
  })).status).toBe(201);
  expect(await (await cliJson(base,askBody())).json()).toMatchObject({action:"hold"});
  now += 1_234;
  const answer = await ownerJson(base,`/api/sessions/${encodeURIComponent(session.key)}/question`,{
    questionId:invocationId,answers:{"Which database?":{selectedOptions:[0]}},
  });
  expect(answer.status).toBe(200);
  const health = await (await fetch(`${base}/healthz`)).json() as {
    autopilot:{dialogMetrics:{outcomes:Record<string,number>;elapsedMs:{total:number}}}
  };
  expect(health.autopilot.dialogMetrics.outcomes.owner_answered).toBe(1);
  expect(health.autopilot.dialogMetrics.elapsedMs.total).toBeGreaterThanOrEqual(1_234);
});

test("dashboard Release to terminal cancels the exact held question and escalates once", async () => {
  Object.assign(process.env, {
    DASH_REPLIES: "1", DASH_AUTOPILOT: "1", DASH_DIALOGS: "1", DASH_DIALOGS_E3_PASS: "1",
    DASH_DIALOGS_E4_PASS: "1", DASH_DIALOGS_E5_MAX_HOLD_MS: "600000",
  });
  const { base, session } = start();
  expect((await ownerJson(base, "/api/autopilot", { enabled:true,away:true })).status).toBe(200);
  expect((await ownerJson(base, `/api/sessions/${encodeURIComponent(session.key)}/autopilot`, {
    action:"create",goalText:"Wait for the owner to choose",delayMin:0,
  })).status).toBe(201);
  expect(await (await cliJson(base, askBody())).json()).toMatchObject({
    action:"hold",invocationId,questionId:invocationId,
  });
  const released = await ownerJson(base, `/api/sessions/${encodeURIComponent(session.key)}/question/release`, { questionId:invocationId });
  expect(released.status).toBe(200);
  expect(await released.json()).toEqual({ ok:true });
  expect(app!.db.getQuestionInvocation(invocationId,session.key,toolUseId)?.state).toBe("cancelled");
  expect(app!.db.sqlite.query("SELECT status FROM autopilot_goals WHERE id=1").get()).toEqual({ status:"escalated" });
  expect(app!.db.sqlite.query(`SELECT COUNT(*) AS count FROM autopilot_decisions
    WHERE goal_id=1 AND gate_rule='dialog' AND status='escalated'`).get()).toEqual({ count:1 });
  const health = await (await fetch(`${base}/healthz`)).json() as { autopilot: { dialogMetrics: { outcomes: Record<string,number> } } };
  expect(health.autopilot.dialogMetrics.outcomes.terminal_released).toBe(1);
});

test("escalates a Claude question when no matching blocking hook invocation exists", async () => {
  Object.assign(process.env, {
    DASH_REPLIES:"1",DASH_AUTOPILOT:"1",DASH_DIALOGS:"1",DASH_DIALOGS_E3_PASS:"1",
    DASH_DIALOGS_E4_PASS:"1",DASH_DIALOGS_E5_MAX_HOLD_MS:"600000",
  });
  const {base,session} = start();
  expect((await ownerJson(base,"/api/autopilot",{enabled:true})).status).toBe(200);
  expect((await ownerJson(base,`/api/sessions/${encodeURIComponent(session.key)}/autopilot`,{
    action:"create",goalText:"Wait for a bounded owner answer",delayMin:0,
  })).status).toBe(201);
  now++;
  const response = await fetch(`${base}/ingest/claude`,{
    method:"POST",headers:{"Content-Type":"application/json","X-Dash-Entrypoint":"cli"},
    body:JSON.stringify({session_id:sessionId,hook_event_name:"PreToolUse",tool_name:"AskUserQuestion",
      tool_use_id:"ask-without-helper",tool_input:{questions:[{question:"Which database?",options:[{label:"SQLite"}]}]}}),
  });
  expect(response.status).toBe(200);
  expect(app!.db.getSession(session.key)?.status).toBe("needs_input");
  expect(app!.db.sqlite.query("SELECT status FROM autopilot_goals WHERE id=1").get()).toEqual({status:"escalated"});
});

test("escalates OMP needs-input events instead of treating them as Claude-hook dialogs", async () => {
  Object.assign(process.env, {
    DASH_REPLIES:"1",DASH_AUTOPILOT:"1",DASH_DIALOGS:"1",DASH_DIALOGS_E3_PASS:"1",
    DASH_DIALOGS_E4_PASS:"1",DASH_DIALOGS_E5_MAX_HOLD_MS:"600000",
  });
  const {base} = start();
  expect((await ownerJson(base,"/api/autopilot",{enabled:true})).status).toBe(200);
  const ompSessionId = "synthetic-omp-dialog";
  const sessionKey = `${localHost()}|omp|${ompSessionId}`;
  const ingest = (kind:"session_start"|"question") => fetch(`${base}/ingest/omp`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({host:localHost(),harness:"omp",sessionId:ompSessionId,kind,ts:++now,interactive:true,text:"Owner input required"}),
  });
  expect((await ingest("session_start")).status).toBe(200);
  expect((await ownerJson(base,`/api/sessions/${encodeURIComponent(sessionKey)}/autopilot`,{
    action:"create",goalText:"Complete a bounded OMP task",delayMin:0,
  })).status).toBe(201);
  expect((await ingest("question")).status).toBe(200);
  expect(app!.db.getSession(sessionKey)?.status).toBe("needs_input");
  expect(app!.db.sqlite.query("SELECT status FROM autopilot_goals").get()).toEqual({status:"escalated"});
});

test("the decisions endpoint returns old unreviewed rows beyond the newest reviewed page", async () => {
  process.env.DASH_REPLIES = "1";
  process.env.DASH_AUTOPILOT = "1";
  const {base,session} = start();
  expect((await ownerJson(base,"/api/autopilot",{enabled:true})).status).toBe(200);
  expect((await ownerJson(base,`/api/sessions/${encodeURIComponent(session.key)}/autopilot`,{
    action:"create",goalText:"Review a bounded decision history",delayMin:0,
  })).status).toBe(201);
  const store = new AutopilotStore(app!.db);
  const goal = store.goalForSession(session.key)!;
  const verdict = {action:"escalate" as const,rationale:"Synthetic owner review",confidence:0.8,risk_flags:[]};
  const record = (decidedAt:number) => store.recordDecision({
    sessionKey:session.key,project:session.project,goalId:goal.id,turnSeq:0,responseId:null,
    responseHash:"a".repeat(40),decisionSetHash:"b".repeat(64),goalVersionId:goal.goalVersionId,
    templateType:null,verdict,delayMin:0,decidedAt,status:"escalated",executionMethod:"none",gateRule:"review",
  });
  const oldUnreviewed = record(now+1);
  for (let index=0; index<100; index++) {
    const recent = record(now+2+index);
    expect(store.markReviewed(recent.id,now+200+index)).toBe(true);
  }
  const response = await fetch(`${base}/api/autopilot/decisions?limit=100&unreviewed=1`);
  const data = await response.json() as {decisions:Array<{id:number;reviewedAt:number|null}>;unreviewed:number};
  expect(response.status).toBe(200);
  expect(data.decisions).toEqual([expect.objectContaining({id:oldUnreviewed.id,reviewedAt:null})]);
  expect(data.unreviewed).toBe(1);
});

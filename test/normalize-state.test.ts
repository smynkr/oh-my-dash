import { describe, test, expect } from "bun:test";
import { normalizeClaude, normalizeOmp, claudeInteractive, describePrompt, type NormalizedEvent } from "../src/normalize.ts";
import { reduceLiveness, reduceState, type SessionState } from "../src/state.ts";

const headers = new Headers({ "X-Dash-Host": "test-host", "X-Dash-Entrypoint": "cli", "X-Dash-Attended": "1" });
const base = { session_id: "synthetic-session", cwd: "/synthetic/project", transcript_path: "/synthetic/a.jsonl" };
const normalize = (hook_event_name: string, extra: Record<string,unknown> = {}) => normalizeClaude({ ...base, hook_event_name, ...extra }, headers, 1000);

describe("Claude normalization", () => {
  test("maps every specified hook and extracts question/options", () => {
    expect(normalize("SessionStart", { source: "startup" })).toMatchObject({kind:"session_start",detail:"startup",cwd:base.cwd,host:"test-host",interactive:true});
    expect(normalize("UserPromptSubmit", { prompt: "synthetic prompt" })).toMatchObject({kind:"prompt",text:"synthetic prompt"});
    const q = normalize("PreToolUse", { tool_name:"AskUserQuestion",tool_input:{questions:[{question:"First?",options:[{label:"A"}]},{question:"Second?",options:[{label:"B"}]}]} });
    expect(q).toMatchObject({kind:"question",text:"First?\nSecond?"});
    expect(q?.detail).toContain("label");
    expect(normalize("PreToolUse", { tool_name:"AskUserQuestion", tool_input:{other:"fallback"} })?.text).toContain("fallback");
    expect(normalize("PostToolUse", { tool_name:"AskUserQuestion" })?.kind).toBe("question_answered");
    expect(normalize("PermissionRequest", { tool_name:"Bash",tool_input:{command:"synthetic"} })).toMatchObject({kind:"permission",detail:"Bash",text:'{"command":"synthetic"}'});
    expect(normalize("PermissionRequest", { tool_name:"AskUserQuestion",tool_input:{questions:[{question:"Choose synthetic?",options:[{label:"A"}]}]} })).toMatchObject({kind:"question",text:"Choose synthetic?"});
    expect(normalize("Notification", { message:"needs input",notification_type:"permission_prompt" })).toMatchObject({kind:"notification",text:"needs input",detail:"permission_prompt"});
    expect(normalize("Stop", { last_assistant_message:"synthetic response",background_tasks:[{}] })).toMatchObject({kind:"response",text:"synthetic response",backgroundTasks:1});
    expect(normalize("StopFailure", { last_assistant_message:"synthetic error" })).toMatchObject({kind:"error",text:"synthetic error"});
    expect(normalize("SessionEnd", { reason:"other" })).toMatchObject({kind:"session_end",detail:"other"});
    expect(normalize("PreToolUse", { tool_name:"Read" })).toBeNull();
    expect(normalize("Unknown")).toBeNull();
  });
  test("interactive is determined by cli entrypoint, including unattended background sessions", () => {
    expect(claudeInteractive(headers)).toBe(true);
    for (const entrypoint of ["sdk-py","sdk-cli",""]) {
      expect(claudeInteractive(new Headers({"X-Dash-Entrypoint":entrypoint,"X-Dash-Attended":"1"}))).toBe(false);
    }
    expect(claudeInteractive(new Headers({"X-Dash-Entrypoint":"cli"}))).toBe(true);
    expect(claudeInteractive(new Headers({"X-Dash-Entrypoint":"cli","X-Dash-Attended":"0"}))).toBe(true);
    expect(claudeInteractive(new Headers())).toBe(false);
    expect(normalizeClaude({ ...base, hook_event_name:"SessionStart" }, new Headers({"X-Dash-Entrypoint":"cli","X-Dash-Kind":"bg"}))?.sessionKind).toBe("bg");
  });
  test("caps OMP text and requires shape", () => {
    expect(normalizeOmp({host:"synthetic",harness:"omp",sessionId:"s",kind:"response",interactive:true,text:"x".repeat(200000)})?.text?.length).toBe(102400);
    expect(normalizeOmp({host:"synthetic",sessionId:"s",kind:"response",interactive:true})).toBeNull();
  });
  test("OMP ask payloads preserve ordered labels, metadata, multi-select, and recommended index", () => {
    const questionData = [
      { id:"synthetic-choice", question:"Choose a synthetic route?", options:[
        {label:"1. Synthetic option one",description:"First description"},
        {label:"3. Synthetic option three",description:"Third description",preview:"Synthetic preview"},
        {label:"4. Synthetic option four"},
      ], recommended:1 },
      { id:"synthetic-flags", question:"Choose synthetic flags?", options:[{label:"Alpha"},{label:"Beta"}], multi:true },
    ];
    const event = normalizeOmp({host:"synthetic-host",harness:"omp",sessionId:"synthetic-session",kind:"question",interactive:true,
      questionIdentity:"question_identity_one",questionData}, 1000);
    expect(event).toMatchObject({kind:"question",questionIdentity:"question_identity_one",questionData});
    const rejected = normalizeOmp({host:"synthetic-host",harness:"omp",sessionId:"synthetic-session",kind:"question",interactive:true,
      questionIdentity:"question_identity_one",questionData:[{id:"synthetic",question:"synthetic",options:[{label:"x".repeat(2049)}]}]}, 1000);
    expect(rejected?.questionIdentity).toBe("question_identity_one");
    expect(rejected?.questionData).toBeUndefined();
    const noIdentity = normalizeOmp({host:"synthetic-host",harness:"omp",sessionId:"synthetic-session",kind:"question",interactive:true,
      questionIdentity:"not a safe identity",questionData}, 1000);
    expect(noIdentity?.questionIdentity).toBeUndefined();
    expect(noIdentity?.questionData).toBeUndefined();
  });
});

test("describes injected prompts and preserves human text", () => {
  expect(describePrompt("<task-notification><summary>synthetic update</summary></task-notification>")).toBe("⟲ Background task update: synthetic update");
  expect(describePrompt("<task-notification>synthetic</task-notification>")).toBe("⟲ Background task update");
  expect(describePrompt(`<task-notification><summary>${"x".repeat(180)}</summary></task-notification>`)).toBe(`⟲ Background task update: ${"x".repeat(160)}`);
  expect(describePrompt("<command-name>test</command-name><command-args>--synthetic</command-args>")).toBe("/test --synthetic");
  expect(describePrompt("<command-message>test</command-message>")).toBe("/test");
  expect(describePrompt("<system-reminder>synthetic</system-reminder>")).toBeNull();
  expect(describePrompt("<local-command-stdout>synthetic</local-command-stdout>")).toBeNull();
  expect(describePrompt("Caveat: synthetic")).toBeNull();
  expect(describePrompt("human synthetic prompt")).toBe("human synthetic prompt");
});

describe("pure status reducer", () => {
  const initial: SessionState = { status:"unknown",lastActivity:0 };
  const event = (kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({host:"h",harness:"claude",sessionId:"s",interactive:true,kind,ts:100,...extra});
  test("all transition rows", () => {
    expect(reduceState(initial,event("session_start")).status).toBe("your_turn");
    expect(reduceState({...initial,status:"working"},event("session_start",{detail:"compact"})).status).toBe("working");
    for (const detail of ["startup","resume","clear","fork"]) expect(reduceState(initial,event("session_start",{detail})).status).toBe("your_turn");
    const asked = reduceState(initial,event("question",{text:"synthetic question"}));
    expect(asked).toMatchObject({status:"needs_input",needsReason:"question",needsText:"synthetic question"});
    expect(reduceState(asked,event("prompt",{text:"synthetic prompt"}))).toMatchObject({status:"working",needsReason:null,needsText:null,lastPrompt:"synthetic prompt"});
    expect(reduceState(asked,event("question_answered"))).toMatchObject({status:"working",needsReason:null,needsText:null});
    expect(reduceState(initial,event("permission",{text:"synthetic input"}))).toMatchObject({status:"needs_input",needsReason:"permission"});
    for (const detail of ["permission_prompt","elicitation_dialog","elicitation_url_dialog"]) expect(reduceState(initial,event("notification",{detail,text:"synthetic notification"}))).toMatchObject({status:"needs_input",needsReason:detail,lastNotification:"synthetic notification"});
    expect(reduceState(asked,event("notification",{detail:"permission_prompt",text:"synthetic raw prompt"}))).toMatchObject({status:"needs_input",needsReason:"question",needsText:"synthetic question"});
    expect(reduceState(initial,event("notification",{detail:"idle_prompt"})).status).toBe("unknown");
    expect(reduceState(initial,event("response",{backgroundTasks:2}))).toMatchObject({status:"your_turn",backgroundPending:true});
    expect(reduceState(initial,event("error",{text:"synthetic error"}))).toMatchObject({status:"your_turn",lastError:"synthetic error"});
    expect(reduceState(initial,event("session_end")).status).toBe("ended");
    expect(reduceState(initial,event("prompt")).lastActivity).toBe(100);
  });
  test("OMP question replacement and completion are bound to the active ask identity", () => {
    const ompEvent = (kind: NormalizedEvent["kind"], extra: Partial<NormalizedEvent> = {}): NormalizedEvent =>
      ({host:"h",harness:"omp",sessionId:"s",interactive:true,kind,ts:100,...extra});
    const first = reduceState(initial,ompEvent("question",{text:"synthetic first",questionIdentity:"question_identity_one"}));
    const second = reduceState(first,ompEvent("question",{text:"synthetic second",questionIdentity:"question_identity_two"}));
    expect(second).toMatchObject({status:"needs_input",needsReason:"question",pendingQuestionId:"question_identity_two"});
    expect(reduceState(second,ompEvent("question_answered",{questionIdentity:"question_identity_one"})))
      .toMatchObject({status:"needs_input",pendingQuestionId:"question_identity_two"});
    expect(reduceState(second,ompEvent("question_answered",{questionIdentity:"question_identity_two"})))
      .toMatchObject({status:"working",needsReason:null,pendingQuestionId:null});
    expect(reduceState(second,ompEvent("question_answered")))
      .toMatchObject({status:"needs_input",needsReason:"question",pendingQuestionId:"question_identity_two"});
    const permission = reduceState(initial,ompEvent("permission",{text:"synthetic approval"}));
    expect(reduceState(permission,ompEvent("question_answered",{questionIdentity:"question_identity_one"})))
      .toMatchObject({status:"needs_input",needsReason:"permission"});
    expect(reduceState(initial,ompEvent("question_answered",{questionIdentity:"question_identity_one"})).status).toBe("unknown");
    expect(reduceState(second,ompEvent("response"))).toMatchObject({status:"your_turn",pendingQuestionId:null});
  });
  test("liveness transitions fill gaps and defer to recent hook events", () => {
    const now = 100_000;
    expect(reduceLiveness(initial,"busy",now).status).toBe("working");
    expect(reduceLiveness({...initial,status:"your_turn"},"busy",now,now-20_000).status).toBe("your_turn");
    expect(reduceLiveness({...initial,status:"your_turn"},"busy",now,now-20_001).status).toBe("working");
    const permission = {...initial,status:"needs_input" as const,needsReason:"permission"};
    expect(reduceLiveness(permission,"busy",now,now-10_000).status).toBe("needs_input");
    expect(reduceLiveness(permission,"busy",now,now-20_001)).toMatchObject({status:"working",needsReason:null});
    expect(reduceLiveness({...permission,needsReason:"permission_prompt"},"busy",now,now-20_001).status).toBe("working");
    expect(reduceLiveness({...permission,needsReason:"question"},"busy",now).status).toBe("needs_input");
    expect(reduceLiveness(initial,"idle",now).status).toBe("your_turn");
    expect(reduceLiveness({...initial,status:"working"},"idle",now,now-60_000).status).toBe("working");
    expect(reduceLiveness({...initial,status:"working"},"idle",now,now-60_001).status).toBe("your_turn");
    for (const status of ["unknown","working","your_turn"] as const) {
      expect(reduceLiveness({...initial,status},"waiting",now,now-10_001)).toMatchObject({status:"needs_input",needsReason:"waiting",needsText:"Waiting for your input"});
      expect(reduceLiveness({...initial,status},"waiting",now,now-10_000).status).toBe(status);
    }
  });
});

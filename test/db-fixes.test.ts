import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashDB } from "../src/db.ts";
import type { NormalizedEvent } from "../src/normalize.ts";

const event = (sessionId: string, kind: NormalizedEvent["kind"], ts: number, text?: string): NormalizedEvent => ({
  host:"synthetic-host", harness:"claude", sessionId, kind, ts, text, interactive:true,
});

test("R1 turn_seq counts duplicate response and error events, ignores prompt/backfill/liveness, and survives reopen", () => {
  const dir = mkdtempSync(join(tmpdir(),"dash-turn-seq-")), path = join(dir,"db.sqlite");
  let db = new DashDB(path);
  const key = "synthetic-host|claude|turns";
  try {
    expect(db.applyEvent(event("turns","prompt",1000,"synthetic prompt")).turnSeq).toBe(0);
    db.applyEvent(event("turns","response",1001,"synthetic same response"));
    const duplicate = db.applyEvent(event("turns","response",1002,"synthetic same response"));
    expect(duplicate.turnSeq).toBe(2);
    expect(db.countResponses()).toBe(1);
    expect(db.applyEvent(event("turns","error",1003,"synthetic error")).turnSeq).toBe(3);
    expect(db.applyEvent(event("turns","prompt",1004,"synthetic next prompt")).turnSeq).toBe(3);
    db.addBackfill({host:"synthetic-host",harness:"claude",sessionId:"turns",transcriptPath:"/synthetic/turns.jsonl",interactive:true,
      responses:[{ts:1005,text:"synthetic backfill"}]});
    db.markLiveness("claude",[],"synthetic-host",1006,()=>true);
    expect(db.getSession(key)?.turnSeq).toBe(3);
  } finally { db.close(); }
  db = new DashDB(path);
  try { expect(db.getSession(key)?.turnSeq).toBe(3); }
  finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("empty responses change status but do not add rows", () => {
  const db = new DashDB(":memory:");
  try {
    db.applyEvent(event("empty","prompt",1000,"synthetic prompt"));
    const dto = db.applyEvent(event("empty","response",1001,"  \n "));
    expect(dto.status).toBe("your_turn");
    expect(dto.lastResponses).toHaveLength(0);
    expect(db.countResponses()).toBe(0);
  } finally { db.close(); }
});

test("hook and backfill responses dedupe in either order after the same 100 KB cap", () => {
  const db = new DashDB(":memory:");
  const text = "x".repeat(100 * 1024 + 50);
  try {
    db.applyEvent(event("hook-first","response",1000,text));
    db.addBackfill({host:"synthetic-host",harness:"claude",sessionId:"hook-first",transcriptPath:"/synthetic/a.jsonl",interactive:true,
      responses:[{ts:1001,text}]});
    expect(db.countResponses()).toBe(1);
    db.addBackfill({host:"synthetic-host",harness:"claude",sessionId:"backfill-first",transcriptPath:"/synthetic/b.jsonl",interactive:true,
      responses:[{ts:2000,text}]});
    db.applyEvent(event("backfill-first","response",2001,text));
    expect(db.countResponses()).toBe(2);
    expect(db.getSession("synthetic-host|claude|backfill-first")?.lastResponses).toHaveLength(1);
  } finally { db.close(); }
});

test("dead Claude sessions end after ten idle minutes or two minutes of confirmed dead pid", () => {
  const db = new DashDB(":memory:");
  const dead = () => false;
  try {
    db.applyEvent(event("idle","prompt",1_000,"synthetic"));
    db.markLiveness("claude",[],"synthetic-host",601_001,dead);
    expect(db.getSession("synthetic-host|claude|idle")?.status).toBe("ended");

    db.applyEvent(event("pid","prompt",700_000,"synthetic"));
    const record = [{host:"synthetic-host",harness:"claude" as const,sessionId:"pid",pid:321,detail:"busy"}];
    db.markLiveness("claude",record,"synthetic-host",700_000,dead);
    db.markLiveness("claude",[],"synthetic-host",700_001,dead);
    expect(db.getSession("synthetic-host|claude|pid")?.status).toBe("working");
    db.markLiveness("claude",[],"synthetic-host",820_000,dead);
    expect(db.getSession("synthetic-host|claude|pid")?.status).toBe("working");
    db.markLiveness("claude",[],"synthetic-host",820_001,dead);
    expect(db.getSession("synthetic-host|claude|pid")?.status).toBe("ended");
  } finally { db.close(); }
});

test("stored prompts are described for both hook and backfill responses", () => {
  const db = new DashDB(":memory:");
  try {
    db.applyEvent(event("prompt","prompt",1000,"<task-notification><summary>synthetic update</summary></task-notification>"));
    const hook = db.applyEvent(event("prompt","response",1001,"synthetic reply"));
    expect(hook.lastPrompt).toBe("⟲ Background task update: synthetic update");
    expect(hook.lastResponses[0].prompt).toBe(hook.lastPrompt);
    db.addBackfill({host:"synthetic-host",harness:"claude",sessionId:"backfill",transcriptPath:"/synthetic/c.jsonl",interactive:true,
      responses:[{ts:2000,text:"synthetic reply 2",prompt:"<system-reminder>synthetic</system-reminder>"}]});
    expect(db.getSession("synthetic-host|claude|backfill")?.lastResponses[0].prompt).toBeUndefined();
  } finally { db.close(); }
});

test("session kind is stored and response dedupe looks across both sources", () => {
  const db = new DashDB(":memory:");
  try {
    db.applyEvent({...event("background","session_start",1000),sessionKind:"bg"});
    expect(db.getSession("synthetic-host|claude|background")?.sessionKind).toBe("bg");
    db.addBackfill({host:"synthetic-host",harness:"claude",sessionId:"background",transcriptPath:"/synthetic/d.jsonl",interactive:true,
      responses:[{ts:1001,text:"synthetic shared"}]});
    db.applyEvent(event("background","response",1002,"synthetic shared"));
    expect(db.countResponses()).toBe(1);
    for (let i=0;i<5;i++) db.applyEvent(event("background","response",1003+i,`synthetic other ${i}`));
    db.applyEvent(event("background","response",1010,"synthetic shared"));
    expect(db.countResponses()).toBe(7);
  } finally { db.close(); }
});

const CHOICE = "Which cache should I use?\nA) Redis\nB) Memcached";
const PROSE_ASK = "Should I keep the queue or drop it?";
const EMPTY_SET = { decisions: [], source: "parser" };
const backfill = (sessionId: string, ...responses: { ts: number; text: string }[]) =>
  ({ host:"synthetic-host", harness:"claude" as const, sessionId, transcriptPath:`/synthetic/${sessionId}.jsonl`, interactive:true, responses });
const states = (db: DashDB, key: string) =>
  db.sqlite.query("SELECT text,decision_state,turn_seq,decisions_json FROM responses WHERE session_key=? ORDER BY id").all(key);

test("R3 parser runs at insert for hook and backfill; pending needs a hook with the judge on; flag off stays skipped", () => {
  const off = new DashDB(":memory:"), parser = new DashDB(":memory:", { decisionsEnabled:true }),
    judge = new DashDB(":memory:", { decisionsEnabled:true, judgeEnabled:true }), judgeOnly = new DashDB(":memory:", { judgeEnabled:true });
  try {
    for (const db of [off, parser, judge, judgeOnly]) {
      db.applyEvent(event("hook","response",1000,CHOICE));
      db.applyEvent(event("hook","response",1001,PROSE_ASK));
      db.applyEvent(event("hook","response",1002,"synthetic status update"));
      db.addBackfill(backfill("old",{ts:900,text:PROSE_ASK}));
    }
    for (const db of [off, judgeOnly]) {
      const latest = db.getSession("synthetic-host|claude|hook")!.lastResponses;
      expect(latest.map(r => [r.decisionState, r.decisions, r.turnSeq])).toEqual([["skipped",null,3],["skipped",null,2],["skipped",null,1]]);
      expect(db.getSession("synthetic-host|claude|old")!.lastResponses[0]).toMatchObject({ decisionState:"skipped", decisions:null, turnSeq:null });
    }
    const choice = parser.responseForTurn("synthetic-host|claude|hook",1)!;
    expect(choice.decisionState).toBe("parser");
    expect(choice.decisions?.decisions.map(d => d.options.map(o => o.label))).toEqual([["Redis","Memcached"]]);
    expect(parser.responseForTurn("synthetic-host|claude|hook",2)).toMatchObject({ decisionState:"none", decisions:EMPTY_SET });
    expect(judge.responseForTurn("synthetic-host|claude|hook",1)?.decisionState).toBe("parser");
    expect(judge.responseForTurn("synthetic-host|claude|hook",2)).toMatchObject({ decisionState:"pending", decisions:null, turnSeq:2 });
    expect(judge.responseForTurn("synthetic-host|claude|hook",3)).toMatchObject({ decisionState:"none", decisions:EMPTY_SET });
    expect(judge.getSession("synthetic-host|claude|old")!.lastResponses[0]).toMatchObject({ decisionState:"none", turnSeq:null, source:"backfill" });
    expect(judge.timeline().find(r => r.text === CHOICE)?.decisions?.decisions).toHaveLength(1);
  } finally { for (const db of [off, parser, judge, judgeOnly]) db.close(); }
});

test("R3 a hook duplicate rebinds the exact matched row (A,B,A) to the new turn and makes it the latest response", () => {
  const db = new DashDB(":memory:", { decisionsEnabled:true }), key = "synthetic-host|claude|aba";
  try {
    db.applyEvent(event("aba","response",1000,CHOICE));
    db.applyEvent(event("aba","response",1001,"synthetic B"));
    const before = db.responseForTurn(key,1)!;
    const dto = db.applyEvent(event("aba","response",1002,CHOICE));
    expect(dto.turnSeq).toBe(3);
    expect(db.countResponses()).toBe(2);
    expect(db.responseForTurn(key,1)).toBeUndefined();
    const rebound = db.responseForTurn(key,3)!;
    expect(rebound.id).toBe(before.id);
    expect(rebound.ts).toBeGreaterThan(db.responseForTurn(key,2)!.ts);
    expect(rebound.decisions).toEqual(before.decisions);
    expect(dto.lastResponses.map(r => [r.text, r.turnSeq])).toEqual([[CHOICE,3],["synthetic B",2]]);
  } finally { db.close(); }
});

test("with decisions off a hook duplicate keeps today's ordering and only records its turn", () => {
  const db = new DashDB(":memory:"), key = "synthetic-host|claude|aba-off";
  try {
    db.applyEvent(event("aba-off","response",1000,"synthetic A"));
    db.applyEvent(event("aba-off","response",1001,"synthetic B"));
    const dto = db.applyEvent(event("aba-off","response",1002,"synthetic A"));
    expect(dto.lastResponses.map(r => [r.text, r.ts])).toEqual([["synthetic B",1001],["synthetic A",1000]]);
    expect(db.responseForTurn(key,3)).toMatchObject({ text:"synthetic A", decisionState:"skipped", decisions:null });
  } finally { db.close(); }
});

test("a hook duplicate of a backfill row or a skipped row is bound to the turn and evaluated now", () => {
  const dir = mkdtempSync(join(tmpdir(),"dash-rebind-")), path = join(dir,"db.sqlite");
  let db = new DashDB(path, { decisionsEnabled:true, judgeEnabled:true });
  const key = "synthetic-host|claude|bf";
  try {
    db.addBackfill(backfill("bf",{ts:1000,text:PROSE_ASK}));
    expect(states(db,key)).toEqual([{ text:PROSE_ASK, decision_state:"none", turn_seq:null, decisions_json:JSON.stringify(EMPTY_SET) }]);
    db.applyEvent(event("bf","response",1001,PROSE_ASK));
    expect(db.countResponses()).toBe(1);
    expect(db.responseForTurn(key,1)).toMatchObject({ source:"hook", decisionState:"pending", decisions:null });
    db.applyEvent(event("bf","response",1002,PROSE_ASK));
    expect(db.responseForTurn(key,2)?.decisionState).toBe("pending");
    db.close();

    db = new DashDB(path);
    db.applyEvent(event("skip","response",2000,CHOICE));
    db.close();
    db = new DashDB(path, { decisionsEnabled:true });
    expect(db.responseForTurn("synthetic-host|claude|skip",1)?.decisionState).toBe("skipped");
    db.applyEvent(event("skip","response",2001,CHOICE));
    expect(db.responseForTurn("synthetic-host|claude|skip",2)).toMatchObject({ decisionState:"parser", turnSeq:2 });
    expect(db.countResponses()).toBe(2);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("R3 resume keeps only current recent hook pending rows and late results never overwrite settled state", () => {
  const db = new DashDB(":memory:", { decisionsEnabled:true, judgeEnabled:true });
  const set = { decisions:[{ title:PROSE_ASK, options:[{key:"A",label:"keep the queue"},{key:"B",label:"drop it"}], recIndex:null, recQuote:null }], source:"luna" as const };
  try {
    db.applyEvent(event("moved","response",1000,PROSE_ASK));
    db.applyEvent(event("moved","error",1001,"synthetic error"));
    db.applyEvent(event("current","response",1002,PROSE_ASK));
    db.applyEvent(event("old","response",1003,PROSE_ASK));
    const moved = db.responseForTurn("synthetic-host|claude|moved",1)!, current = db.responseForTurn("synthetic-host|claude|current",1)!;
    const old = db.responseForTurn("synthetic-host|claude|old",1)!;
    expect([moved, current, old].map(r => r.decisionState)).toEqual(["pending","pending","pending"]);
    db.sqlite.query("UPDATE responses SET ts=? WHERE id=?").run(1002 - 86_400_000, old.id);
    expect(db.resumablePending(1003)).toEqual([current.id]);
    expect(db.resumablePending(1003)).toEqual([current.id]);
    expect([moved, old].map(r => db.getResponse(r.id))).toMatchObject([{ decisionState:"none", decisions:EMPTY_SET },{ decisionState:"none" }]);
    expect(db.setDecisionsIfPending(moved.id,set,"luna")).toBe(0);
    expect(db.setDecisionsIfPending(current.id,set,"luna")).toBe(1);
    expect(db.setDecisionsIfPending(current.id,EMPTY_SET as any,"failed")).toBe(0);
    expect(db.getResponse(current.id)).toMatchObject({ decisionState:"luna", decisions:set });
    expect(db.resumablePending(1003)).toEqual([]);
  } finally { db.close(); }
});

test("R3 pending rows left by a judge-on run are settled as none once the judge is off", () => {
  const dir = mkdtempSync(join(tmpdir(),"dash-judge-off-")), path = join(dir,"db.sqlite");
  let db = new DashDB(path, { decisionsEnabled:true, judgeEnabled:true });
  try {
    db.applyEvent(event("judge-off","response",1000,PROSE_ASK));
    expect(db.resumablePending(1000)).toHaveLength(1);
    db.close();
    db = new DashDB(path, { decisionsEnabled:true });
    expect(db.resumablePending(1000)).toEqual([]);
    expect(db.responseForTurn("synthetic-host|claude|judge-off",1)).toMatchObject({ decisionState:"none", decisions:EMPTY_SET });
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("R3 legacy responses gain inert decision columns and malformed stored decisions surface as null", () => {
  const dir = mkdtempSync(join(tmpdir(),"dash-legacy-responses-")), path = join(dir,"db.sqlite");
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE sessions (key TEXT PRIMARY KEY, host TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT NOT NULL,
      cwd TEXT, title TEXT, display_name TEXT, status TEXT NOT NULL DEFAULT 'unknown', needs_reason TEXT, needs_text TEXT,
      last_prompt TEXT, last_error TEXT, last_notification TEXT, background_pending INTEGER NOT NULL DEFAULT 0,
      interactive INTEGER NOT NULL DEFAULT 0, alive INTEGER NOT NULL DEFAULT 0, pid INTEGER, transcript_path TEXT,
      created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL);
    CREATE TABLE responses (id INTEGER PRIMARY KEY, session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
      ts INTEGER NOT NULL, text TEXT NOT NULL, prompt TEXT, seen INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, text_sha1 TEXT NOT NULL);
    INSERT INTO sessions(key,host,harness,session_id,status,interactive,created_at,last_activity)
      VALUES('synthetic-host|claude|legacy','synthetic-host','claude','legacy','your_turn',1,100,100);
    INSERT INTO responses(session_key,ts,text,source,text_sha1) VALUES('synthetic-host|claude|legacy',100,'synthetic legacy','hook','x');`);
  legacy.close();
  let db = new DashDB(path, { decisionsEnabled:true, judgeEnabled:true });
  try {
    const columns = db.sqlite.query("PRAGMA table_info(responses)").all() as { name: string }[];
    expect(columns.map(c => c.name)).toEqual(expect.arrayContaining(["decisions_json","decision_state","turn_seq"]));
    expect(db.sqlite.query("SELECT 1 FROM sqlite_master WHERE type='index' AND name='responses_decision_pending'").get()).toBeTruthy();
    expect(db.getSession("synthetic-host|claude|legacy")!.lastResponses[0]).toMatchObject({ decisionState:"skipped", decisions:null, turnSeq:null });
    expect(db.resumablePending(1000)).toEqual([]);
    db.close();
    db = new DashDB(path);
    for (const json of ["{bad", "[]", "{\"decisions\":\"x\",\"source\":\"parser\"}", "{\"decisions\":[],\"source\":\"judge\"}", "null"]) {
      db.sqlite.query("UPDATE responses SET decisions_json=?,decision_state='parser'").run(json);
      expect(db.getSession("synthetic-host|claude|legacy")!.lastResponses[0].decisions).toBeNull();
      expect(db.timeline()[0].decisions).toBeNull();
    }
    db.sqlite.query("UPDATE responses SET decisions_json=?").run(JSON.stringify({ decisions:[{ title:"Invented", options:[{key:"A",label:"nowhere"},{key:"B",label:"else"}], recIndex:0, recQuote:"my pick A" }], source:"luna" }));
    expect(db.timeline()[0].decisions).toEqual({ decisions:[], source:"luna" });
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

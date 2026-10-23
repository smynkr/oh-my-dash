import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashDB } from "../src/db.ts";
import { AutopilotStore } from "../src/autopilot-store.ts";
import { SEED_PROJECT_RULES } from "../src/projects.ts";
import { createAudit } from "../src/audit.ts";
import type { NormalizedEvent } from "../src/normalize.ts";

const enqueue = (db: DashDB, key: string, text: string, now: number, ttlMs: number) =>
  db.enqueueReply(key,text,"web","web:loopback",undefined,now,ttlMs);

test("replies are FIFO per session and persist across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-replies-"));
  const path = join(dir, "db.sqlite");
  let db = new DashDB(path);
  const one = enqueue(db,"host|claude|a","synthetic first",100,1_000);
  enqueue(db,"host|claude|b","synthetic other",101,1_000);
  enqueue(db,"host|claude|a","synthetic second",102,1_000);
  db.close();
  db = new DashDB(path);
  try {
    expect(db.nextQueuedReply("host|claude|a")?.id).toBe(one.id);
    expect(db.queuedReplies().map(r => r.text)).toContain("synthetic second");
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("terminal transitions purge text and expiry and cancellation select only active matches", () => {
  const db = new DashDB(":memory:");
  try {
    const expired = enqueue(db,"a","synthetic expired",1,10);
    const cancelled = enqueue(db,"a","synthetic cancel",2,100);
    const other = enqueue(db,"b","synthetic other",3,100);
    expect(db.expireReplies(11).map(r => r.id)).toEqual([expired.id]);
    expect(db.getReply(expired.id)?.text).toBe("");
    expect(db.cancelReplies("a", 12).map(r => r.id)).toEqual([cancelled.id]);
    expect(db.getReply(cancelled.id)?.text).toBe("");
    db.setReplyState(other.id,"leased",13,20);
    expect(db.expiredLeases(20).map(r => r.id)).toEqual([other.id]);
    expect(db.getReply(other.id)).toMatchObject({state:"delivered",text:""});
    expect(db.replyCounts()).toEqual({queued:0,leased:0,delivered:1,expired:1,cancelled:1});
  } finally { db.close(); }
});

test("R1 migrates a post-4a database idempotently and preserves legacy reply data", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-pre4b-"));
  const path = join(dir,"db.sqlite");
  const seed = new Database(path);
  seed.exec(`
    CREATE TABLE sessions (
      key TEXT PRIMARY KEY,host TEXT NOT NULL,harness TEXT NOT NULL,session_id TEXT NOT NULL,cwd TEXT,title TEXT,
      display_name TEXT,status TEXT NOT NULL DEFAULT 'unknown',needs_reason TEXT,needs_text TEXT,last_prompt TEXT,
      last_error TEXT,last_notification TEXT,background_pending INTEGER NOT NULL DEFAULT 0,
      interactive INTEGER NOT NULL DEFAULT 0,alive INTEGER NOT NULL DEFAULT 0,pid INTEGER,transcript_path TEXT,
      session_kind TEXT,last_hook_event_ts INTEGER,last_liveness_status TEXT,dead_since INTEGER,
      created_at INTEGER NOT NULL,last_activity INTEGER NOT NULL
    );
    INSERT INTO sessions(key,host,harness,session_id,status,interactive,created_at,last_activity)
      VALUES('synthetic-host|claude|session','synthetic-host','claude','session','working',1,1,1);
    CREATE TABLE settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);
    CREATE TABLE replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,session_key TEXT NOT NULL,text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','leased','delivered','expired','cancelled')),
      created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,lease_until INTEGER,done_at INTEGER,
      tg_msg_id INTEGER,tg_chat_id TEXT
    );
    INSERT INTO replies(session_key,text,state,created_at,expires_at,tg_msg_id,tg_chat_id)
      VALUES('synthetic-host|claude|session','synthetic legacy reply','queued',10,1000,89,'54321');
  `);
  seed.close();
  let db = new DashDB(path);
  try {
    expect(db.getSession("synthetic-host|claude|session")?.turnSeq).toBe(0);
    expect(db.getReply(1)).toMatchObject({text:"synthetic legacy reply",state:"queued",source:"telegram",actor:null,answersTurn:null,tgMsgId:89,tgChatId:"54321"});
    expect((db.sqlite.query("PRAGMA table_info(sessions)").all() as {name:string}[]).filter(column => column.name === "turn_seq")).toHaveLength(1);
    expect((db.sqlite.query("PRAGMA table_info(replies)").all() as {name:string}[]).filter(column => column.name === "source")).toHaveLength(1);
    expect((db.sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND name='replies_session_source_state'").all() as unknown[])).toHaveLength(1);
    expect(db.sqlite.query("SELECT name FROM pragma_table_info('sessions') WHERE name='pending_question_id'").all()).toHaveLength(1);
    expect(db.sqlite.query("SELECT name FROM pragma_table_info('replies') WHERE name='answers_question'").all()).toHaveLength(1);
  } finally { db.close(); }
  db = new DashDB(path);
  try {
    expect(db.getSession("synthetic-host|claude|session")?.turnSeq).toBe(0);
    expect(db.getReply(1)).toMatchObject({text:"synthetic legacy reply",state:"queued",source:"telegram",tgChatId:"54321"});
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("R1 hand-out checks turn and status atomically and public replies omit private fields", () => {
  const db = new DashDB(":memory:");
  const key = "synthetic-host|claude|session";
  try {
    db.applyEvent({host:"synthetic-host",harness:"claude",sessionId:"session",kind:"session_start",detail:"startup",ts:1,interactive:true});
    const turn = db.getSession(key)!.turnSeq;
    const statusBlocked = enqueue(db,key,"synthetic queued",2,1000);
    db.applyEvent({host:"synthetic-host",harness:"claude",sessionId:"session",kind:"prompt",ts:3,interactive:true});
    expect(db.takeQueuedForClaude(key,statusBlocked.id,turn,4)).toEqual({kind:"not_ready"});
    expect(db.getReply(statusBlocked.id)?.state).toBe("queued");

    db.applyEvent({host:"synthetic-host",harness:"claude",sessionId:"session",kind:"response",ts:5,text:"synthetic response",interactive:true});
    const currentTurn = db.getSession(key)!.turnSeq;
    const stale = db.enqueueReply(key,"synthetic stale","web","web:loopback",currentTurn-1,6,1000);
    expect(db.takeQueuedForClaude(key,stale.id,currentTurn,7).kind).toBe("stale");
    expect(db.getReply(stale.id)).toMatchObject({state:"cancelled",text:"",cancelReason:"stale"});

    const fresh = db.enqueueReply(key,"synthetic fresh","web","web:loopback",currentTurn,8,1000);
    const delivered = db.takeQueuedForClaude(key,fresh.id,currentTurn,9);
    expect(delivered).toMatchObject({kind:"taken",reply:{text:"synthetic fresh",state:"delivered"}});
    expect(db.takeQueuedForClaude(key,fresh.id,currentTurn,10)).toEqual({kind:"unavailable"});
    expect(db.getReply(fresh.id)).toMatchObject({state:"delivered",text:""});
    const publicDto = db.getReplies(key,100)[0];
    expect(publicDto).toMatchObject({id:fresh.id,state:"delivered",source:"web",answersTurn:currentTurn,committed:false});
    expect(publicDto).not.toHaveProperty("text");
    expect(publicDto).not.toHaveProperty("actor");
    expect(publicDto).not.toHaveProperty("tgChatId");
    expect(publicDto).not.toHaveProperty("textSha256");
  } finally { db.close(); }
});

test("R1 cancellation includes queued and uncommitted leases but keeps committed replies", () => {
  const db = new DashDB(":memory:");
  const key = "synthetic-host|omp|session";
  try {
    db.applyEvent({host:"synthetic-host",harness:"omp",sessionId:"session",kind:"session_start",detail:"startup",ts:1,interactive:true});
    const queued = db.enqueueReply(key,"synthetic auto","autopilot","autopilot:goal:1",0,2,1000);
    const leased = db.enqueueReply(key,"synthetic web","web","web:loopback",0,3,1000);
    const committed = db.enqueueReply(key,"synthetic telegram","telegram","telegram:7",0,4,1000);
    expect(db.leaseQueuedForOmp(key,leased.id,"waiter0001",0,5,true).kind).toBe("leased");
    expect(db.leaseQueuedForOmp(key,committed.id,"waiter0002",0,6,true).kind).toBe("leased");
    expect(db.commitOmp(committed.id,"waiter0002",7)).toEqual({ok:true});
    const changed = db.cancelReplies({key,source:"web",reason:"owner_cancelled"},8);
    expect(changed.map(reply => reply.id)).toEqual([leased.id]);
    expect(db.getReply(leased.id)).toMatchObject({state:"cancelled",text:"",cancelReason:"owner_cancelled"});
    expect(db.cancelReplies({id:queued.id,reason:"owner_replied"},9).map(reply => reply.id)).toEqual([queued.id]);
    expect(db.cancelReplies({id:committed.id,reason:"owner_replied"},10)).toEqual([]);
    expect(db.commitOmp(leased.id,"waiter0001",11)).toMatchObject({ok:false,reason:"not_leased"});
    expect(db.getReply(committed.id)).toMatchObject({state:"leased",committedAt:7,text:"synthetic telegram"});
  } finally { db.close(); }
});

test("autopilot budget is rechecked at Claude handout and OMP commitment", () => {
  const db = new DashDB(":memory:", { decisionsEnabled:true });
  const autopilot = new AutopilotStore(db);
  const now = 1_000_000;
  const seedBudget = (goalId:number) => {
    for (let index=0; index<30; index++) db.sqlite.query(`INSERT INTO autopilot_turn_events
      (event_key,goal_id,event_kind,created_at) VALUES(?,?,'reply',?)`)
      .run(`synthetic-budget:${goalId}:${index}`,goalId,now-1_000+index);
  };
  try {
    const claude = db.applyEvent({host:"synthetic-host",harness:"claude",sessionId:"budget-claude",
      kind:"session_start",ts:now,interactive:true});
    db.applyEvent({host:"synthetic-host",harness:"claude",sessionId:"budget-claude",
      kind:"response",ts:now+1,text:"Synthetic response",interactive:true});
    const claudeGoal = autopilot.createGoal({sessionKey:claude.key,goalText:"Bounded Claude task",expiresAt:now+60_000},now+1);
    const claudeReply = db.enqueueReply(claude.key,"Synthetic fixed reply","autopilot",`autopilot:goal:${claudeGoal.id}`,
      db.getSession(claude.key)!.turnSeq,now+2,60_000);
    seedBudget(claudeGoal.id);
    expect(db.takeQueuedForClaude(claude.key,claudeReply.id,db.getSession(claude.key)!.turnSeq,now+3).kind).toBe("not_ready");
    db.sqlite.query("DELETE FROM autopilot_turn_events").run();

    const omp = db.applyEvent({host:"synthetic-host",harness:"omp",sessionId:"budget-omp",
      kind:"session_start",ts:now+4,interactive:true});
    const ompGoal = autopilot.createGoal({sessionKey:omp.key,goalText:"Bounded OMP task",expiresAt:now+60_000},now+4);
    const ompReply = db.enqueueReply(omp.key,"Synthetic fixed reply","autopilot",`autopilot:goal:${ompGoal.id}`,
      db.getSession(omp.key)!.turnSeq,now+5,60_000);
    expect(db.leaseQueuedForOmp(omp.key,ompReply.id,"synthetic-budget",db.getSession(omp.key)!.turnSeq,now+6,true).kind)
      .toBe("leased");
    seedBudget(ompGoal.id);
    expect(db.commitOmp(ompReply.id,"synthetic-budget",now+7)).toEqual({ok:false,reason:"not_ready"});
  } finally { db.close(); }
});

test("R4 stores only a hash and redacted preview and allows one audit outcome fill", () => {
  const db = new DashDB(":memory:");
  const audit = createAudit(db);
  const key = "synthetic-host|claude|audit";
  const now = 50_000;
  const submitted = `synthetic request sk-${"x".repeat(20)}`;
  try {
    const context = audit.prepare({ts:now,sessionKey:key,source:"web",actor:"web:loopback",listener:"loopback",text:submitted});
    const reply = db.enqueueReply(key,submitted,"web","web:loopback",undefined,now,60_000,context);
    audit.record({ts:now+1,sessionKey:key,source:"telegram",actor:"telegram:7",listener:"telegram",text:"synthetic refusal",outcome:"refused:session_ended",outcomeTs:now+1});
    const stored = db.sqlite.query("SELECT text_sha256,text_redacted,actor,listener,outcome,outcome_ts FROM reply_audit WHERE reply_id=?").get(reply.id) as Record<string,unknown>;
    expect(stored).toMatchObject({
      text_sha256:createHash("sha256").update(submitted).digest("hex"),
      text_redacted:"synthetic request [redacted]",actor:"web:loopback",listener:"loopback",outcome:null,outcome_ts:null,
    });
    expect(String(stored.text_redacted).length).toBeLessThanOrEqual(500);
    expect(audit.list(key)).toHaveLength(2);
    expect(audit.list(key)[0]).not.toHaveProperty("textSha256");
    expect(audit.list(key)[0]).not.toHaveProperty("text");

    expect(db.cancelReplies({id:reply.id,reason:"owner_cancelled"},now+2)).toHaveLength(1);
    expect(db.cancelReplies({id:reply.id,reason:"owner_cancelled"},now+3)).toHaveLength(0);
    expect(audit.list(key).filter(entry => entry.replyId === reply.id)).toMatchObject([{outcome:"cancelled:owner_cancelled",outcomeTs:now+2}]);

    const pendingId = audit.record({ts:now+4,sessionKey:key,source:"web",actor:"web:loopback",listener:"loopback",text:"synthetic terminal"});
    expect(() => db.sqlite.query("UPDATE reply_audit SET actor='web:other' WHERE id=?").run(pendingId)).toThrow();
    db.sqlite.query("UPDATE reply_audit SET outcome='delivered',outcome_ts=? WHERE id=?").run(now+5,pendingId);
    expect(() => db.sqlite.query("UPDATE reply_audit SET outcome='expired',outcome_ts=? WHERE id=?").run(now+6,pendingId)).toThrow();
  } finally { db.close(); }
});

test("R4 retention removes only rows older than 90 days and keeps active replies", () => {
  const db = new DashDB(":memory:");
  const audit = createAudit(db), day = 86400_000, now = 100 * day;
  const key = "synthetic-host|claude|retention";
  try {
    for (const age of [91,89]) {
      const ts = now - age * day;
      audit.record({ts,sessionKey:key,source:"web",actor:"web:loopback",listener:"loopback",text:`synthetic audit ${age}d`,outcome:"refused:session_ended",outcomeTs:ts});
      const reply = enqueue(db,key,`synthetic terminal ${age}d`,ts,1);
      db.cancelReplies({id:reply.id,reason:"owner_cancelled"},ts);
    }
    const active = db.enqueueReply(key,"synthetic still queued","web","web:loopback",undefined,now-100*day,200*day);
    expect(audit.prune(now)).toBe(1);
    expect(db.pruneReplies(now)).toBe(1);
    expect((db.sqlite.query("SELECT COUNT(*) AS n FROM reply_audit").get() as {n:number}).n).toBe(1);
    expect(db.getReply(active.id)?.state).toBe("queued");
    expect(db.getReply(active.id)?.text).toBe("synthetic still queued");
  } finally { db.close(); }
});

test("alert records prune entries older than seven days", () => {
  const db = new DashDB(":memory:");
  try {
    const now = 10 * 86400_000;
    db.rememberAlert("12345",1,"synthetic-key","alert",now-7*86400_000-1);
    db.rememberAlert("12345",2,null,"digest",now);
    expect(db.alertFor("12345",1)).toBeUndefined();
    expect(db.alertFor("12345",2)).toEqual({sessionKey:null,kind:"digest"});
  } finally { db.close(); }
});

const event = (sessionId: string, cwd: string): NormalizedEvent => ({
  host: "synthetic-host", harness: "claude", sessionId, kind: "prompt", ts: 1000,
  cwd, interactive: true,
});

test("project rules are cached, malformed settings fall back safely, and flag-off DTOs keep basename", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-project-rules-"));
  const path = join(dir, "db.sqlite");
  let db = new DashDB(path, { topicsEnabled: true });
  const sessionKey = "synthetic-host|claude|session";
  try {
    expect(db.getSetting("projects.rules")).toBeTruthy();

    db.applyEvent(event("session", "/projects/invest/task"));
    expect(db.getSession(sessionKey)?.project).toBe("invest");

    const custom = [{ pattern: "^/custom/([^/]+)", project: "$1" }];
    db.setSetting("projects.rules", JSON.stringify(custom));
    db.applyEvent(event("session", "/custom/alpha/work"));
    expect(db.getSession(sessionKey)?.project).toBe("alpha");
    expect(db.getProjectRules()).toEqual({ rules: custom, errors: [] });

    const invalidRegex = [
      { pattern: "[", project: "ignored" },
      { pattern: "^/custom/([^/]+)", project: "$1" },
    ];
    db.setSetting("projects.rules", JSON.stringify(invalidRegex));
    expect(db.getProjectRules()).toEqual({ rules: invalidRegex, errors: [{ index: 0, error: "invalid regex" }] });
    db.applyEvent(event("session", "/custom/beta/work"));
    expect(db.getSession(sessionKey)?.project).toBe("beta");

    db.setSetting("projects.rules", "{bad json");
    expect(db.getProjectRules()).toMatchObject({ errors: [{ index: -1, error: "invalid JSON" }] });
    db.applyEvent(event("session", "/projects/gamma/task"));
    expect(db.getSession(sessionKey)?.project).toBe("gamma");

    db.setSetting("projects.rules", JSON.stringify({ pattern: "x", project: "invalid-shape" }));
    expect(db.getProjectRules()).toMatchObject({ errors: [{ index: -1, error: "invalid rules" }] });
    db.applyEvent(event("session", "/projects/gamma/task/nested"));
    expect(db.getSession(sessionKey)?.project).toBe("gamma");
  } finally {
    db.close();
  }

  db = new DashDB(path);
  try {
    db.applyEvent(event("session", "/projects/gamma/task/nested"));
    expect(db.getSession(sessionKey)?.project).toBe("nested");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fresh topic databases seed requested defaults without replacing stored rules on reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-project-seed-"));
  const path = join(dir, "db.sqlite");
  const custom = [{ pattern: "^/custom/([^/]+)", project: "$1" }];
  let db = new DashDB(path, { topicsEnabled: true });
  try {
    expect(db.getProjectRules()).toEqual({ rules: SEED_PROJECT_RULES, errors: [] });
    db.applyEvent(event("seed", "/Volumes/Clawdata/tmp/invest-123/task"));
    expect(db.getSession("synthetic-host|claude|seed")?.project).toBe("invest");
    db.setSetting("projects.rules", JSON.stringify(custom));
  } finally { db.close(); }

  db = new DashDB(path, { topicsEnabled: true });
  try {
    expect(db.getProjectRules()).toEqual({ rules: custom, errors: [] });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("replies.kind migrates onto older databases and older rows read as reply", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-kind-"));
  const path = join(dir, "db.sqlite");
  const raw = new Database(path);
  raw.exec(`CREATE TABLE replies (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','leased','delivered','expired','cancelled')), created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, lease_until INTEGER, done_at INTEGER, tg_msg_id INTEGER, tg_chat_id TEXT)`);
  raw.query("INSERT INTO replies(session_key,text,state,created_at,expires_at) VALUES('host|claude|a','synthetic old','queued',1,2)").run();
  raw.close();
  const db = new DashDB(path);
  try {
    const old = db.nextQueuedReply("host|claude|a")!;
    expect([old.kind, old.ideaId]).toEqual(["reply", null]);
    const message = db.enqueueReply("host|claude|a","synthetic new","web","web:loopback",undefined,3,10,undefined,"message");
    expect(db.getReply(message.id)!.kind).toBe("message");
    expect(() => db.sqlite.query("UPDATE replies SET kind='other' WHERE id=?").run(message.id)).toThrow();
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("draft and idea transitions are single conditional updates that act once", () => {
  const db = new DashDB(":memory:");
  try {
    const draft = db.createDraft({ chatId:"42", threadId:null, sourceMessageId:7, text:"synthetic draft", targets:["h|claude|a","h|omp|b"] }, 1_000);
    expect([draft.state, draft.expiresAt, draft.targets, draft.pickerMessageId]).toEqual(["pending", 1_000 + 30*60_000, ["h|claude|a","h|omp|b"], null]);
    expect(db.setDraftPicker(draft.id, 99)).toBe(true);
    expect(db.dueDrafts(1_000 + 30*60_000 - 1)).toEqual([]);
    expect(db.dueDrafts(1_000 + 30*60_000).map(d => d.id)).toEqual([draft.id]);
    expect(db.transitionDraft(draft.id, "pending", "sent")).toBe(true);
    expect(db.transitionDraft(draft.id, "pending", "sent")).toBe(false);
    // The text survives the pre-submit claim (a refusal returns the draft to pending) and is dropped once finished.
    expect(db.getDraft(draft.id)!.text).toBe("synthetic draft");
    expect(db.transitionDraft(draft.id, "sent", "sent", 5)).toBe(true);
    expect([db.getDraft(draft.id)!.replyId, db.getDraft(draft.id)!.text]).toEqual([5, ""]);
    for (const to of ["idea", "cancelled", "expired"] as const) {
      const other = db.createDraft({ chatId:"42", text:"synthetic other", targets:[] }, 1_000);
      expect(db.transitionDraft(other.id, "pending", to)).toBe(true);
      expect(db.getDraft(other.id)!.text).toBe("");
    }
    expect(db.transitionDraft(draft.id, "sent", "pending")).toBe(true);
    expect(db.getDraft(draft.id)!.replyId).toBe(null);
    expect(db.transitionDraft(draft.id, "pending", "cancelled")).toBe(true);
    expect(db.setDraftPicker(draft.id, 100)).toBe(false);
    expect(db.dueDrafts(Number.MAX_SAFE_INTEGER)).toEqual([]);

    let changes = 0;
    db.onIdeasChange = () => changes++;
    const idea = db.createIdea({ text:"synthetic idea", source:"telegram", actor:"telegram:1", origin:"owner" }, 5);
    expect([idea.state, idea.origin, db.openIdeaCount(), changes]).toEqual(["open", "owner", 1, 1]);
    const sent = db.enqueueReply("h|claude|a", idea.text, "web", "web:loopback", undefined, 6, 1_000, undefined, "message", idea.id);
    expect(sent).toMatchObject({ state:"queued", sessionKey:"h|claude|a", ideaId:idea.id });
    expect(db.getIdea(idea.id)).toMatchObject({ state:"sent", sentReplyId:sent!.id, sentSessionKey:"h|claude|a" });
    expect(db.enqueueReply("h|claude|a", idea.text, "web", "web:loopback", undefined, 6, 1_000, undefined, "message", idea.id)).toBeUndefined();
    expect(db.queuedReplies()).toHaveLength(1);
    expect(db.archiveIdea(idea.id, 7)).toBe(false);
    expect(db.reopenIdea(idea.id, sent!.id + 1)).toBe(false);
    expect(db.reopenIdea(idea.id, sent!.id)).toBe(true);
    expect(db.getIdea(idea.id)).toMatchObject({ state:"open", sentReplyId:null, sentSessionKey:null, doneAt:null });
    expect(db.archiveIdea(idea.id, 8)).toBe(true);
    expect(db.archiveIdea(idea.id, 9)).toBe(false);
    expect([db.openIdeaCount(), changes]).toEqual([0, 4]);
    const second = db.createIdea({ text:"synthetic second", source:"web", actor:"web:loopback", origin:"owner" }, 10);
    expect(db.listIdeas("all").map(i => i.id)).toEqual([second.id, idea.id]);
    expect(db.listIdeas("archived").map(i => i.id)).toEqual([idea.id]);
    expect(db.listIdeas().map(i => i.id)).toEqual([second.id]);
  } finally { db.close(); }
});

test("picker re-map bumps rev, a stranded send claim comes back due, and draft->idea is atomic", () => {
  const db = new DashDB(":memory:");
  try {
    // Re-mapping targets bumps the picker rev; finished drafts are never re-mapped.
    const remap = db.createDraft({ chatId:"42", text:"synthetic remap", targets:["h|claude|a"] }, 1_000);
    expect(remap.rev).toBe(0);
    expect(db.setDraftTargets(remap.id, ["h|omp|b"])).toBe(true);
    expect(db.getDraft(remap.id)).toMatchObject({ rev:1, targets:["h|omp|b"] });
    // A send claim that never recorded a reply comes back due, so its text is not stranded.
    expect(db.transitionDraft(remap.id, "pending", "sent")).toBe(true);
    expect(db.setDraftTargets(remap.id, [])).toBe(false);
    expect(db.dueDrafts(1_000 + 30*60_000).map(d => [d.id, d.state])).toEqual([[remap.id, "sent"]]);
    // draft->idea is one transaction: a failure saving the idea leaves the draft and its text untouched.
    db.onIdeasChange = () => { throw new Error("synthetic idea failure"); };
    expect(() => db.draftToIdea(remap.id, "sent", { text:"synthetic remap", source:"telegram", actor:"telegram:1", origin:"draft_expired" }, 2_000)).toThrow();
    expect(db.getDraft(remap.id)).toMatchObject({ state:"sent", text:"synthetic remap" });
    expect(db.listIdeas("all")).toEqual([]);
    db.onIdeasChange = undefined;
    const saved = db.draftToIdea(remap.id, "sent", { text:"synthetic remap", source:"telegram", actor:"telegram:1", origin:"draft_expired" }, 2_000)!;
    expect([saved.text, db.getDraft(remap.id)!.state, db.getDraft(remap.id)!.text]).toEqual(["synthetic remap", "idea", ""]);
    expect(db.draftToIdea(remap.id, "sent", { text:"again", source:"telegram", actor:"telegram:1", origin:"draft_expired" }, 2_000)).toBeUndefined();
  } finally { db.close(); }
});

test("undelivered messages flow back to Ideas; replies and owner cancels never do", () => {
  const db = new DashDB(":memory:");
  try {
    const key = "host|claude|a";
    const msg = (text: string) => db.enqueueReply(key,text,"telegram","telegram:7",undefined,1,10,undefined,"message");
    const expired = msg("synthetic lost");
    db.enqueueReply(key,"synthetic plain reply","web","web:loopback",undefined,1,10);
    const out = db.expireReplies(20);
    expect(out.map(r => r.savedIdeaId === undefined)).toEqual([false, true]);
    expect(db.getIdea(out[0]!.savedIdeaId!)).toMatchObject({ text:"synthetic lost", origin:"undelivered", source:"telegram", actor:"telegram:7", state:"open" });
    expect(db.getReply(expired.id)!.text).toBe("");

    const owner = msg("synthetic owner cancel");
    expect(db.cancelReplies({ key, id: owner.id, reason:"owner_cancelled" }, 30)[0]!.savedIdeaId).toBeUndefined();
    const ended = msg("synthetic ended");
    expect(db.getIdea(db.cancelReplies({ key, reason:"ended" }, 31)[0]!.savedIdeaId!)!.origin).toBe("undelivered");

    const idea = db.createIdea({ text:"synthetic from idea", source:"web", actor:"web:loopback", origin:"owner" }, 32);
    const sent = db.enqueueReply(key,idea.text,"telegram","telegram:7",undefined,1,10,undefined,"message",idea.id)!;
    const before = db.listIdeas("all").length;
    expect(db.expireReplies(1_000)[0]!.savedIdeaId).toBe(idea.id);
    expect([db.getIdea(idea.id)!.state, db.listIdeas("all").length]).toEqual(["open", before]);
    expect(ended.kind).toBe("message");
  } finally { db.close(); }
});

test("OMP pending ask identity and choices survive storage and answer only their own completion", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-omp-question-"));
  const path = join(dir, "db.sqlite");
  let db = new DashDB(path);
  const key = "synthetic-host|omp|question";
  const now = Date.now();
  const questionData: NonNullable<NormalizedEvent["questionData"]> = [
    { id: "synthetic-choice", question: "Choose a synthetic route?",
      options: [{ label: "1. Synthetic option one" }, { label: "3. Synthetic option three" }, { label: "4. Synthetic option four" }],
      recommended: 1 },
    { id: "synthetic-flags", question: "Choose synthetic flags?", options: [{ label: "Alpha" }, { label: "Beta" }],
      multi: true, recommended: 0 },
  ];
  const event = (kind: NormalizedEvent["kind"], ts: number, extra: Partial<NormalizedEvent> = {}) => db.applyEvent({
    host: "synthetic-host", harness: "omp", sessionId: "question", kind, ts, interactive: true, ...extra,
  });
  try {
    const started = event("session_start", now, { detail: "startup", cwd: "/projects/synthetic-repo/src" });
    event("question", now + 1, { questionIdentity: "question_identity_one", questionData, text: "Choose a synthetic route?" });
    expect(db.getSession(key)).toMatchObject({ status: "needs_input", turnSeq: started.turnSeq, pendingQuestion: {
      id: "question_identity_one", questions: questionData,
    } });
    expect(db.countResponses()).toBe(0);
    db.close();

    db = new DashDB(path);
    expect(db.getSession(key)?.pendingQuestion).toEqual({ id: "question_identity_one", questions: questionData });
    event("question", now + 2, { questionIdentity: "question_identity_two", questionData, text: "Choose another synthetic route?" });
    const stale = JSON.stringify({ questionIdentity: "stale_question_identity", questionData, text: "synthetic stale question" });
    db.sqlite.query("INSERT INTO events(session_key,ts,kind,detail) VALUES(?,?,?,?)").run(key, now + 1, "question", stale);
    expect(db.getSession(key)?.pendingQuestion).toEqual({ id: "question_identity_two", questions: questionData });
    db.sqlite.query("DELETE FROM events WHERE session_key=? AND kind='question' AND detail=?").run(key, stale);
    event("question_answered", now + 3, { questionIdentity: "question_identity_one" });
    expect(db.getSession(key)).toMatchObject({ status: "needs_input", pendingQuestion: { id: "question_identity_two" } });
    event("question_answered", now + 4, { questionIdentity: "question_identity_two" });
    expect(db.getSession(key)).toMatchObject({ status: "working" });
    expect(db.getSession(key)?.pendingQuestion).toBeUndefined();
    expect(db.getSession(key)?.turnSeq).toBe(started.turnSeq);
    expect(JSON.parse(db.latestQuestionDetail(key) ?? "[]")).toMatchObject([
      [{ label: "1. Synthetic option one" }, { label: "3. Synthetic option three (Recommended)" }, { label: "4. Synthetic option four" }],
      [{ label: "Alpha" }, { label: "Beta" }],
    ]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("response rows carry the same cwd and project metadata in session and timeline DTOs", () => {
  const db = new DashDB(":memory:", { topicsEnabled: true });
  const key = "synthetic-host|claude|timeline";
  const cwd = "/projects/synthetic-repo/src";
  const now = Date.now();
  try {
    db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "timeline", kind: "session_start",
      ts: now, cwd, interactive: true });
    const session = db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "timeline", kind: "response",
      ts: now + 1, cwd, text: "Synthetic response", interactive: true });
    const responseId = session.lastResponses[0]!.id;
    const metadata = { cwd, project: "synthetic-repo" };
    expect(session.lastResponses[0]).toMatchObject(metadata);
    expect(db.getResponse(responseId)).toMatchObject(metadata);
    expect(db.responseForTurn(key, session.turnSeq)).toMatchObject(metadata);
    expect(db.timeline()[0]).toMatchObject(metadata);
  } finally { db.close(); }
});

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import type { AskQuestion, NormalizedEvent, Harness, PendingQuestion } from "./normalize.ts";
import { clip, describePrompt, sessionKey, normalizeQuestions } from "./normalize.ts";
import { reduceLiveness, reduceState, type SessionState, type Status } from "./state.ts";
import type { BackfillSession } from "./backfill.ts";
import type { LivenessRecord } from "./liveness.ts";
import { resolveProject, ruleErrors, SEED_PROJECT_RULES, type ProjectRule } from "./projects.ts";
import type { PreparedAuditContext, ReplyAuditDTO, ReplyAuditInsert } from "./audit.ts";
import { extractDecisions, extractRecommendation, looksDecisionLike, validateDecisionSet, type DecisionSet } from "./decisions.ts";
import { redactSpan } from "./redact.ts";

// A3 on the dashboard: the agent's own words, redacted like the Telegram line.
const recommendationQuote = (text: string) => { const found = extractRecommendation(text); return found ? redactSpan(text, found.start, found.end) : null; };

type Row = Record<string, unknown>;
const hash = (text: string) => createHash("sha1").update(text).digest("hex");
const value = (v: unknown) => v === undefined ? null : v;
const n = (v: unknown) => Number(v ?? 0);
const s = (v: unknown) => v == null ? undefined : String(v);
const bool = (v: unknown) => !!n(v);

export interface SessionDTO {
  key: string; host: string; harness: Harness; sessionId: string; cwd?: string; title?: string;
  displayName: string; project: string; status: Status; needsReason?: string; needsText?: string;
  pendingQuestionId?: string;
  pendingQuestion?: PendingQuestion;
  lastPrompt?: string; lastError?: string; lastNotification?: string; backgroundPending: boolean;
  interactive: boolean; alive: boolean; pid?: number; transcriptPath?: string; createdAt: number;
  lastActivity: number; unreadCount: number; lastResponses: ResponseDTO[]; sessionKind?: string; turnSeq: number;
}
export interface ResponseDTO {
  id: number; sessionKey: string; ts: number; text: string; prompt?: string; seen: boolean; source: "hook" | "backfill";
  displayName?: string; host?: string; harness?: Harness; sessionId?: string; cwd?: string; project: string;
  decisions: DecisionSet | null; decisionState: DecisionState; turnSeq: number | null;
  // A3 display-only quote for the dashboard; present only with the replies flag on.
  recommendation?: string | null;
}
export type DecisionState = "skipped" | "none" | "parser" | "pending" | "luna" | "failed";
export type CardState = "pending" | "active" | "sent" | "stale" | "expired" | "failed";
export type CardPlace = { chatId: string; threadId: number | null; messageId: number | null };
export interface Card extends CardPlace {
  id: number; sessionKey: string; responseId: number; turnSeq: number; picks: Record<string, number> | null;
  state: CardState; replyId: number | null; createdAt: number; expiresAt: number; decisions: DecisionSet;
}
export const CARD_TTL_MS = 86_400_000;
export type ReplyState = "queued" | "leased" | "delivered" | "expired" | "cancelled";
export type ReplySource = "telegram" | "web" | "autopilot";
export type ReplyAuditListener = "loopback" | "tailnet" | "telegram" | "internal";
export interface Reply {
  id: number; sessionKey: string; text: string; state: ReplyState; createdAt: number;
  expiresAt: number; leaseUntil: number | null; doneAt: number | null; tgMsgId: number | null; tgChatId: string | null;
  source: ReplySource; actor: string | null; answersTurn: number | null; answersQuestion: string | null; cancelReason: string | null;
  committedAt: number | null; leaseCommit: boolean | null;
}
export interface ReplyPublicDTO {
  id: number; state: ReplyState; source: ReplySource; createdAt: number; expiresAt: number;
  doneAt: number | null; cancelReason: string | null; answersTurn: number | null; committed: boolean;
}
export type ReplyTakeResult =
  | { kind: "taken" | "leased"; reply: Reply }
  | { kind: "stale"; reply: Reply }
  | { kind: "not_ready" | "unavailable" };
export type ReplyCommitResult =
  | { ok: true }
  | { ok: false; reason: "stale"; reply: Reply }
  | { ok: false; reason: "not_found" | "not_leased" | "not_commit_capable" | "not_ready" };
export type CancelReplyFilters = { key?: string; source?: ReplySource; id?: number; reason: string };
export type QuestionInvocationState = "pending" | "answered" | "consumed" | "cancelled" | "expired";
export interface QuestionInvocation {
  id: string; sessionKey: string; toolUseId: string; questions: AskQuestion[]; state: QuestionInvocationState;
  answers?: Record<string, string>; source?: ReplySource; actor?: string; listener?: ReplyAuditListener;
  createdAt: number; expiresAt: number; answeredAt?: number; lastHookEventAt?: number; doneAt?: number; cancelReason?: string;
}
export type QuestionRegistration = { ok: true; dto: SessionDTO; replaced: string[] } | { ok: false; reason: "duplicate" | "session_ended" };
export type TelegramQuestionMessage = {
  questionId: string; sessionKey: string; chatId: string; threadId: number | null;
  messageId: number; questionIndex: number; createdAt: number; prompt: boolean;
};
export type AlertKind = "alert" | "digest";
export type ProjectRuleError = { index: number; error: "invalid regex" | "invalid JSON" | "invalid rules" };
export type ProjectRulesState = { rules: ProjectRule[]; errors: ProjectRuleError[] };

function isProjectRuleArray(value: unknown): value is ProjectRule[] {
  if (!Array.isArray(value) || value.length > 32) return false;
  return value.every(rule => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
    const row = rule as Record<string, unknown>;
    return Object.keys(row).length === 2
      && Object.keys(row).every(key => key === "pattern" || key === "project")
      && typeof row.pattern === "string" && row.pattern.length >= 1 && row.pattern.length <= 256
      && typeof row.project === "string" && row.project.length >= 1 && row.project.length <= 128;
  });
}

function cloneRules(rules: readonly ProjectRule[]): ProjectRule[] {
  return rules.map(rule => ({ pattern: rule.pattern, project: rule.project }));
}

class CardIdOverflow extends Error {}

// Picks are decimal decision indexes mapped to option indexes, both checked against the card's DecisionSet.
function validPicks(raw: unknown, set: DecisionSet): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const picks: Record<string, number> = {};
  for (const [slot, option] of Object.entries(raw)) {
    const options = /^[0-7]$/.test(slot) ? set.decisions[Number(slot)]?.options : undefined;
    if (!options || !Number.isInteger(option) || option < 0 || option >= options.length) return null;
    picks[slot] = option;
  }
  return picks;
}

export class DashDB {
  readonly sqlite: Database;
  private lastResponseTs = 0;
  private readonly topicsEnabled: boolean;
  private readonly decisionsEnabled: boolean;
  private readonly judgeEnabled: boolean;
  private projectRulesState: ProjectRulesState = { rules: cloneRules(SEED_PROJECT_RULES), errors: [] };
  constructor(path: string, { topicsEnabled = false, decisionsEnabled = false, judgeEnabled = false }:
    { topicsEnabled?: boolean; decisionsEnabled?: boolean; judgeEnabled?: boolean } = {}) {
    this.topicsEnabled = topicsEnabled;
    this.decisionsEnabled = decisionsEnabled;
    this.judgeEnabled = decisionsEnabled && judgeEnabled;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path);
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, host TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT NOT NULL,
        cwd TEXT, title TEXT, display_name TEXT, status TEXT NOT NULL DEFAULT 'unknown',
        needs_reason TEXT, needs_text TEXT, pending_question_id TEXT, last_prompt TEXT, last_error TEXT, last_notification TEXT,
        background_pending INTEGER NOT NULL DEFAULT 0, interactive INTEGER NOT NULL DEFAULT 0,
        alive INTEGER NOT NULL DEFAULT 0, pid INTEGER, transcript_path TEXT,
        session_kind TEXT, last_hook_event_ts INTEGER, last_liveness_status TEXT, dead_since INTEGER,
        created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY, session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
        ts INTEGER NOT NULL, text TEXT NOT NULL, prompt TEXT, seen INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL, text_sha1 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS responses_session_ts ON responses(session_key, ts DESC);
      CREATE INDEX IF NOT EXISTS responses_ts ON responses(ts DESC);
      CREATE INDEX IF NOT EXISTS responses_hash ON responses(session_key, text_sha1);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
        ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS events_session_kind ON events(session_key, kind);
      CREATE TABLE IF NOT EXISTS question_invocations (
        question_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','answered','consumed','cancelled','expired')),
        answers_json TEXT,
        source TEXT,
        actor TEXT,
        listener TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        answered_at INTEGER,
        done_at INTEGER,
        cancel_reason TEXT,
        UNIQUE(session_key,tool_use_id)
      );
      CREATE INDEX IF NOT EXISTS question_invocations_live ON question_invocations(session_key,state,expires_at);
      CREATE TABLE IF NOT EXISTS tg_question_messages (
        question_id TEXT NOT NULL,
        session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        thread_id INTEGER,
        message_id INTEGER NOT NULL,
        question_index INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        is_prompt INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(chat_id,message_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tg_question_messages_card ON tg_question_messages(question_id,question_index)
        WHERE is_prompt=0;
      CREATE INDEX IF NOT EXISTS tg_question_messages_session ON tg_question_messages(session_key,created_at);
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        text TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','leased','delivered','expired','cancelled')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        lease_until INTEGER,
        done_at INTEGER,
        tg_msg_id INTEGER,
        tg_chat_id TEXT,
        answers_question TEXT
      );
      CREATE INDEX IF NOT EXISTS replies_session_state_id ON replies(session_key,state,id);
      CREATE TABLE IF NOT EXISTS reply_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        reply_id INTEGER,
        session_key TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('telegram','web','autopilot')),
        actor TEXT NOT NULL,
        listener TEXT NOT NULL CHECK (listener IN ('loopback','tailnet','telegram','internal')),
        text_sha256 TEXT NOT NULL CHECK (length(text_sha256)=64),
        text_redacted TEXT NOT NULL CHECK (length(text_redacted)<=500),
        outcome TEXT,
        outcome_ts INTEGER,
        goal_id INTEGER,
        rule TEXT
      );
      CREATE INDEX IF NOT EXISTS reply_audit_session_ts ON reply_audit(session_key,ts DESC,id DESC);
      CREATE INDEX IF NOT EXISTS reply_audit_ts ON reply_audit(ts);
      CREATE UNIQUE INDEX IF NOT EXISTS reply_audit_reply_id_unique ON reply_audit(reply_id) WHERE reply_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS reply_audit_append_only
      BEFORE UPDATE ON reply_audit
      WHEN NOT (
        OLD.outcome IS NULL AND OLD.outcome_ts IS NULL AND NEW.outcome IS NOT NULL AND NEW.outcome_ts IS NOT NULL
        AND NEW.id IS OLD.id AND NEW.ts IS OLD.ts AND NEW.reply_id IS OLD.reply_id
        AND NEW.session_key IS OLD.session_key AND NEW.source IS OLD.source AND NEW.actor IS OLD.actor
        AND NEW.listener IS OLD.listener AND NEW.text_sha256 IS OLD.text_sha256
        AND NEW.text_redacted IS OLD.text_redacted AND NEW.goal_id IS OLD.goal_id AND NEW.rule IS OLD.rule
      )
      BEGIN
        SELECT RAISE(ABORT, 'reply audit is append-only');
      END;
      CREATE TABLE IF NOT EXISTS tg_alerts (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        session_key TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('alert','digest')),
        sent_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS tg_urgent_episodes (
        session_key TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        repaged_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS tg_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        response_id INTEGER NOT NULL,
        turn_seq INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id INTEGER,
        message_id INTEGER,
        picks_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL CHECK (state IN ('pending','active','sent','stale','expired','failed')),
        reply_id INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tg_cards_session_turn ON tg_cards(session_key,turn_seq);
      CREATE INDEX IF NOT EXISTS tg_cards_expiry ON tg_cards(expires_at,state);
      CREATE INDEX IF NOT EXISTS tg_cards_reply ON tg_cards(reply_id);
    `);
    const columns = new Set((this.sqlite.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map(c => c.name));
    const replyColumns = new Set((this.sqlite.query("PRAGMA table_info(replies)").all() as { name: string }[]).map(c => c.name));
    const responseColumns = new Set((this.sqlite.query("PRAGMA table_info(responses)").all() as { name: string }[]).map(c => c.name));
    this.sqlite.transaction(() => {
      for (const [name, type] of [["session_kind", "TEXT"], ["last_hook_event_ts", "INTEGER"], ["last_liveness_status", "TEXT"], ["dead_since", "INTEGER"], ["turn_seq", "INTEGER NOT NULL DEFAULT 0"], ["pending_question_id", "TEXT"]] as const) {
        if (!columns.has(name)) this.sqlite.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
      }
      if (!replyColumns.has("tg_chat_id")) this.sqlite.exec("ALTER TABLE replies ADD COLUMN tg_chat_id TEXT");
      for (const [name, type] of [["source", "TEXT NOT NULL DEFAULT 'telegram'"], ["actor", "TEXT"], ["answers_turn", "INTEGER"], ["cancel_reason", "TEXT"], ["committed_at", "INTEGER"], ["lease_commit", "INTEGER"], ["answers_question", "TEXT"]] as const) {
        if (!replyColumns.has(name)) this.sqlite.exec(`ALTER TABLE replies ADD COLUMN ${name} ${type}`);
      }
      this.sqlite.exec("UPDATE replies SET tg_chat_id=COALESCE((SELECT v FROM settings WHERE k='telegram.chat_id'),'') WHERE tg_msg_id IS NOT NULL AND tg_chat_id IS NULL");
      this.sqlite.exec("CREATE INDEX IF NOT EXISTS replies_session_source_state ON replies(session_key,source,state,id)");
      for (const [name, type] of [["decisions_json", "TEXT"], ["decision_state", "TEXT NOT NULL DEFAULT 'skipped'"], ["turn_seq", "INTEGER"]] as const) {
        if (!responseColumns.has(name)) this.sqlite.exec(`ALTER TABLE responses ADD COLUMN ${name} ${type}`);
      }
      this.sqlite.exec("CREATE INDEX IF NOT EXISTS responses_decision_pending ON responses(decision_state,id)");
    this.invalidateInterruptedQuestions(Date.now());
    })();
    const alertColumns = new Set((this.sqlite.query("PRAGMA table_info(tg_alerts)").all() as { name: string }[]).map(c => c.name));
    if (!alertColumns.has("chat_id")) {
      this.sqlite.transaction(() => {
        this.sqlite.exec(`CREATE TABLE tg_alerts_new (
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    session_key TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('alert','digest')),
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  );
  INSERT INTO tg_alerts_new (chat_id, message_id, session_key, kind, sent_at)
    SELECT COALESCE((SELECT v FROM settings WHERE k='telegram.chat_id'), ''),
           message_id, session_key, kind, sent_at FROM tg_alerts;
  DROP TABLE tg_alerts;
  ALTER TABLE tg_alerts_new RENAME TO tg_alerts;`);
      })();
    }
    if (!alertColumns.has("content")) this.sqlite.exec("ALTER TABLE tg_alerts ADD COLUMN content TEXT");
    this.lastResponseTs = n((this.sqlite.query("SELECT MAX(ts) AS ts FROM responses").get() as Row)?.ts);
    const storedRules = this.getSetting("projects.rules");
    this.refreshProjectRules(storedRules);
    if (this.topicsEnabled && storedRules === undefined) this.setSetting("projects.rules", JSON.stringify(SEED_PROJECT_RULES));
  }
  close() { this.sqlite.close(); }
  getSetting(key: string): string | undefined {
    const row = this.sqlite.query("SELECT v FROM settings WHERE k=?").get(key) as { v: string } | null;
    return row?.v;
  }
  setSetting(key: string, setting: string): void {
    this.sqlite.query("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(key, setting);
    if (key === "projects.rules") this.refreshProjectRules(setting);
  }
  deleteSetting(key: string): void {
    this.sqlite.query("DELETE FROM settings WHERE k=?").run(key);
  }
  deleteSettingsPrefix(prefix: string): number {
    return this.sqlite.query("DELETE FROM settings WHERE substr(k,1,length(?1))=?1").run(prefix).changes;
  }
  private refreshProjectRules(raw: string | undefined): void {
    if (raw === undefined) {
      this.projectRulesState = { rules: cloneRules(SEED_PROJECT_RULES), errors: [] };
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.projectRulesState = { rules: cloneRules(SEED_PROJECT_RULES), errors: [{ index: -1, error: "invalid JSON" }] };
      return;
    }
    if (!isProjectRuleArray(parsed)) {
      this.projectRulesState = { rules: cloneRules(SEED_PROJECT_RULES), errors: [{ index: -1, error: "invalid rules" }] };
      return;
    }
    this.projectRulesState = { rules: cloneRules(parsed), errors: ruleErrors(parsed) };
  }
  getProjectRules(): ProjectRulesState {
    return { rules: cloneRules(this.projectRulesState.rules), errors: this.projectRulesState.errors.map(error => ({ ...error })) };
  }
  private reply(row: Row | null): Reply | undefined {
    if (!row) return undefined;
    return { id:n(row.id), sessionKey:String(row.session_key), text:String(row.text), state:row.state as ReplyState,
      createdAt:n(row.created_at), expiresAt:n(row.expires_at), leaseUntil:row.lease_until == null ? null : n(row.lease_until),
      doneAt:row.done_at == null ? null : n(row.done_at), tgMsgId:row.tg_msg_id == null ? null : n(row.tg_msg_id),
      tgChatId:s(row.tg_chat_id) ?? null, source:row.source as ReplySource, actor:s(row.actor) ?? null,
      answersTurn:row.answers_turn == null ? null : n(row.answers_turn), answersQuestion:s(row.answers_question) ?? null,
      cancelReason:s(row.cancel_reason) ?? null, committedAt:row.committed_at == null ? null : n(row.committed_at),
      leaseCommit:row.lease_commit == null ? null : bool(row.lease_commit) };
  }
  private insertAuditRow(entry: ReplyAuditInsert): number {
    const result = this.sqlite.query(`INSERT INTO reply_audit
      (ts,reply_id,session_key,source,actor,listener,text_sha256,text_redacted,outcome,outcome_ts,goal_id,rule)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(entry.ts,value(entry.replyId),entry.sessionKey,entry.source,entry.actor,entry.listener,
        entry.textSha256,entry.textRedacted,value(entry.outcome),value(entry.outcomeTs),value(entry.goalId),value(entry.rule));
    return Number(result.lastInsertRowid);
  }
  insertAudit(entry: ReplyAuditInsert): number { return this.insertAuditRow(entry); }
  listAudit(key: string, limit = 100): ReplyAuditDTO[] {
    const bounded = Math.min(100, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 100)));
    const rows = this.sqlite.query(`SELECT id,ts,reply_id,session_key,source,actor,listener,text_redacted,outcome,outcome_ts,goal_id,rule
      FROM reply_audit WHERE session_key=? ORDER BY ts DESC,id DESC LIMIT ?`).all(key,bounded) as Row[];
    return rows.map(row => ({ id:n(row.id), ts:n(row.ts), replyId:row.reply_id == null ? null : n(row.reply_id),
      sessionKey:String(row.session_key), source:row.source as ReplySource, actor:String(row.actor),
      listener:row.listener as ReplyAuditListener, textRedacted:String(row.text_redacted), outcome:s(row.outcome) ?? null,
      outcomeTs:row.outcome_ts == null ? null : n(row.outcome_ts), goalId:row.goal_id == null ? null : n(row.goal_id),
      rule:s(row.rule) ?? null }));
  }
  pruneAudit(now: number): number {
    const cutoff = now - 90 * 86400_000;
    return this.sqlite.transaction(() => this.sqlite.query(`DELETE FROM reply_audit WHERE id IN (
      SELECT id FROM reply_audit WHERE ts<? ORDER BY ts,id LIMIT 500
    )`).run(cutoff).changes)();
  }
  private auditEntryFromContext(context: PreparedAuditContext, replyId: number | null): ReplyAuditInsert {
    return { ts:context.ts, replyId, sessionKey:context.sessionKey, source:context.source, actor:context.actor,
      listener:context.listener, textSha256:context.textSha256, textRedacted:context.textRedacted,
      outcome:context.outcome ?? null, outcomeTs:context.outcomeTs ?? null,
      goalId:context.goalId ?? null, rule:context.rule ?? null };
  }
  enqueueReply(key: string, text: string, source: ReplySource, actor: string, answersTurn: number | undefined,
    now: number, ttlMs: number, auditContext?: PreparedAuditContext, answersQuestion?: string): Reply {
    return this.sqlite.transaction(() => {
      if (auditContext && (auditContext.sessionKey !== key || auditContext.source !== source || auditContext.actor !== actor)) {
        throw new Error("reply audit context mismatch");
      }
      const result = this.sqlite.query(`INSERT INTO replies(session_key,text,state,created_at,expires_at,source,actor,answers_turn,answers_question)
        VALUES(?,?,'queued',?,?,?,?,?,?)`).run(key,text,now,now+ttlMs,source,actor,value(answersTurn),value(answersQuestion));
      const id = Number(result.lastInsertRowid);
      if (auditContext) this.insertAuditRow(this.auditEntryFromContext(auditContext,id));
      return this.getReply(id)!;
    })();
  }
  getReply(id: number): Reply | undefined { return this.reply(this.sqlite.query("SELECT * FROM replies WHERE id=?").get(id) as Row | null); }
  getReplies(key: string, limit = 20): ReplyPublicDTO[] {
    const bounded = Math.min(100, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 20)));
    return (this.sqlite.query(`SELECT id,state,source,created_at,expires_at,done_at,cancel_reason,answers_turn,committed_at
      FROM replies WHERE session_key=? ORDER BY id DESC LIMIT ?`).all(key,bounded) as Row[]).map(row => ({
        id:n(row.id), state:row.state as ReplyState, source:row.source as ReplySource, createdAt:n(row.created_at),
        expiresAt:n(row.expires_at), doneAt:row.done_at == null ? null : n(row.done_at),
        cancelReason:s(row.cancel_reason) ?? null, answersTurn:row.answers_turn == null ? null : n(row.answers_turn),
        committed:row.committed_at != null,
      }));
  }
  nextQueuedReply(key: string, includeAutopilot = true): Reply | undefined {
    const sql = includeAutopilot
      ? "SELECT * FROM replies WHERE session_key=? AND state='queued' ORDER BY id LIMIT 1"
      : "SELECT * FROM replies WHERE session_key=? AND state='queued' AND source!='autopilot' ORDER BY id LIMIT 1";
    return this.reply(this.sqlite.query(sql).get(key) as Row | null);
  }
  private auditOutcome(replyId: number, outcome: string, now: number): void {
    this.sqlite.query(`UPDATE reply_audit SET outcome=?,outcome_ts=?
      WHERE reply_id=? AND outcome IS NULL AND outcome_ts IS NULL`).run(outcome,now,replyId);
  }
  private finishReply(row: Row, state: "delivered"|"expired"|"cancelled", now: number, cancelReason: string | null = null,
    allowCommitted = false): Reply {
    this.sqlite.query(`UPDATE replies SET state=?,text='',lease_until=NULL,done_at=?,cancel_reason=?
      WHERE id=? AND state IN ('queued','leased') AND (?=1 OR committed_at IS NULL)`).run(state,now,value(cancelReason),row.id,allowCommitted ? 1 : 0);
    this.auditOutcome(n(row.id), state === "cancelled" ? `cancelled:${cancelReason ?? "cancelled"}` : state, now);
    return this.reply({ ...row, state, text:"", lease_until:null, done_at:now, cancel_reason:cancelReason })!;
  }
  private takeQueued(key: string, id: number, turnSeq: number, now: number, mode: "claude"|"omp", waiterId?: string,
    commitCapable = false): ReplyTakeResult {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.query(`SELECT r.*,s.turn_seq,s.status AS session_status,s.needs_reason,s.pending_question_id,s.harness AS session_harness
        FROM replies r JOIN sessions s ON s.key=r.session_key WHERE r.id=? AND r.session_key=?`).get(id,key) as Row | null;
      if (!row || row.state !== "queued" || n(row.expires_at) <= now) return { kind:"unavailable" } as const;
      const currentTurn = n(row.turn_seq);
      if (row.answers_turn != null && (n(row.answers_turn) !== currentTurn || n(row.answers_turn) !== turnSeq)) {
        return { kind:"stale",reply:this.finishReply(row,"cancelled",now,"stale") } as const;
      }
      if (row.answers_question != null && (mode !== "omp" || String(row.session_harness) !== "omp" ||
          String(row.session_status) !== "needs_input" || String(row.needs_reason) !== "question" ||
          s(row.pending_question_id) !== String(row.answers_question) ||
          this.questionAnswered(String(row.session_key), String(row.answers_question)))) {
        return { kind:"stale",reply:this.finishReply(row,"cancelled",now,"stale_question") } as const;
      }
      const status = String(row.session_status), bound = row.answers_turn != null;
      const deliverable = mode === "claude"
        ? String(row.session_harness) === "claude" && status === "your_turn"
        : String(row.session_harness) === "omp" && (bound ? status === "your_turn" :
          status === "working" || status === "your_turn" || status === "needs_input" && ["question","waiting"].includes(String(row.needs_reason)));
      if (!deliverable || mode === "omp" && waiterId !== undefined && !commitCapable && row.source === "autopilot") {
        return { kind:"not_ready" } as const;
      }
      const copy = this.reply(row)!;
      if (mode === "claude") {
        const changes = this.sqlite.query(`UPDATE replies SET state='delivered',text='',lease_until=NULL,done_at=?,cancel_reason=NULL
          WHERE id=? AND state='queued' AND committed_at IS NULL`).run(now,id).changes;
        if (changes !== 1) return { kind:"unavailable" } as const;
        this.auditOutcome(id,"delivered",now);
        return { kind:"taken",reply:{ ...copy,state:"delivered",doneAt:now,leaseUntil:null } } as const;
      }
      const changes = this.sqlite.query(`UPDATE replies SET state='leased',lease_until=?,done_at=NULL,lease_commit=?,committed_at=NULL,cancel_reason=NULL
        WHERE id=? AND state='queued' AND committed_at IS NULL`).run(now+60_000,commitCapable ? 1 : 0,id).changes;
      if (changes !== 1) return { kind:"unavailable" } as const;
      return { kind:"leased",reply:{ ...copy,state:"leased",leaseUntil:now+60_000,doneAt:null,leaseCommit:commitCapable,committedAt:null } } as const;
    })();
  }
  takeQueuedForClaude(key: string, id: number, turnSeq: number, now: number): ReplyTakeResult {
    return this.takeQueued(key,id,turnSeq,now,"claude");
  }
  leaseQueuedForOmp(key: string, id: number, waiterId: string, turnSeq: number, now: number, commitCapable = false): ReplyTakeResult {
    return this.takeQueued(key,id,turnSeq,now,"omp",waiterId,commitCapable);
  }
  commitOmp(id: number, _waiterId: string, now: number): ReplyCommitResult {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.query(`SELECT r.*,s.turn_seq,s.status AS session_status,s.needs_reason,s.pending_question_id,s.harness AS session_harness
        FROM replies r JOIN sessions s ON s.key=r.session_key WHERE r.id=?`).get(id) as Row | null;
      if (!row) return { ok:false,reason:"not_found" } as const;
      if (row.state !== "leased" || row.lease_until == null || n(row.lease_until) <= now) return { ok:false,reason:"not_leased" } as const;
      if (!bool(row.lease_commit)) return { ok:false,reason:"not_commit_capable" } as const;
      const status = String(row.session_status);
      const deliverable = String(row.session_harness) === "omp" && (row.answers_turn != null ? status === "your_turn" :
        status === "working" || status === "your_turn" || status === "needs_input" && ["question","waiting"].includes(String(row.needs_reason)));
      const stale = row.answers_turn != null && n(row.answers_turn) !== n(row.turn_seq);
      const questionFresh = row.answers_question == null || String(row.session_harness) === "omp" &&
        String(row.session_status) === "needs_input" && String(row.needs_reason) === "question" &&
        s(row.pending_question_id) === String(row.answers_question) &&
        !this.questionAnswered(String(row.session_key), String(row.answers_question));
      if (row.committed_at != null) return !stale && questionFresh && deliverable ? { ok:true } as const : { ok:false,reason:"not_ready" } as const;
      if (stale) {
        return { ok:false,reason:"stale",reply:this.finishReply(row,"cancelled",now,"stale") } as const;
      }
      if (!questionFresh) {
        return { ok:false,reason:"stale",reply:this.finishReply(row,"cancelled",now,"stale_question") } as const;
      }
      if (!deliverable) {
        this.sqlite.query(`UPDATE replies SET state='queued',lease_until=NULL,lease_commit=NULL,committed_at=NULL
          WHERE id=? AND state='leased' AND committed_at IS NULL`).run(id);
        return { ok:false,reason:"not_ready" } as const;
      }
      const changes = this.sqlite.query(`UPDATE replies SET committed_at=? WHERE id=? AND state='leased'
        AND lease_until>? AND lease_commit=1 AND committed_at IS NULL`).run(now,id,now).changes;
      return changes === 1 ? { ok:true } as const : { ok:false,reason:"not_leased" } as const;
    })();
  }
  ackReply(id: number, now: number): Reply | undefined {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.query("SELECT * FROM replies WHERE id=?").get(id) as Row | null;
      if (!row || row.state !== "leased" || bool(row.lease_commit) && row.committed_at == null) return undefined;
      return this.finishReply(row,"delivered",now,null,true);
    })();
  }
  deferReply(id: number, _now: number): Reply | undefined {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.query("SELECT * FROM replies WHERE id=?").get(id) as Row | null;
      if (!row || row.state !== "leased" || row.committed_at != null) return undefined;
      const changes = this.sqlite.query(`UPDATE replies SET state='queued',lease_until=NULL,done_at=NULL,lease_commit=NULL
        WHERE id=? AND state='leased' AND committed_at IS NULL`).run(id).changes;
      return changes === 1 ? this.getReply(id) : undefined;
    })();
  }
  setReplyState(id: number, state: ReplyState, now: number, leaseUntil?: number): void {
    if (state === "leased") this.sqlite.query(`UPDATE replies SET state='leased',lease_until=?,done_at=NULL,lease_commit=NULL
      WHERE id=? AND state='queued'`).run(value(leaseUntil),id);
    else if (state === "queued") { this.deferReply(id,now); }
    else this.sqlite.transaction(() => {
      const row = this.sqlite.query("SELECT * FROM replies WHERE id=?").get(id) as Row | null;
      if (row && (row.state === "queued" || row.state === "leased") && row.committed_at == null) this.finishReply(row,state,now,state === "cancelled" ? "cancelled" : null);
    })();
  }
  setReplyTgMsg(id: number, chatId: string, msgId: number): void {
    this.sqlite.query("UPDATE replies SET tg_chat_id=?,tg_msg_id=? WHERE id=?").run(chatId,msgId,id);
  }
  queuedReplies(includeAutopilot = true): Reply[] {
    const sql = includeAutopilot ? "SELECT * FROM replies WHERE state='queued' ORDER BY id"
      : "SELECT * FROM replies WHERE state='queued' AND source!='autopilot' ORDER BY id";
    return (this.sqlite.query(sql).all() as Row[]).map(r=>this.reply(r)!);
  }
  expireReplies(now: number): Reply[] {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite.query("SELECT * FROM replies WHERE state='queued' AND expires_at<=? ORDER BY id").all(now) as Row[];
      return rows.map(row => this.finishReply(row,"expired",now));
    })();
  }
  cancelReplies(filters: CancelReplyFilters | string | null, now: number): Reply[] {
    const parsed: CancelReplyFilters = typeof filters === "string" || filters === null
      ? { ...(filters ? { key:filters } : {}), reason:"owner_cancelled" } : filters;
    return this.sqlite.transaction(() => {
      const clauses = ["state IN ('queued','leased')","committed_at IS NULL"], args: unknown[] = [];
      if (parsed.key !== undefined) { clauses.push("session_key=?"); args.push(parsed.key); }
      if (parsed.source !== undefined) { clauses.push("source=?"); args.push(parsed.source); }
      if (parsed.id !== undefined) { clauses.push("id=?"); args.push(parsed.id); }
      const rows = this.sqlite.query(`SELECT * FROM replies WHERE ${clauses.join(" AND ")} ORDER BY id`).all(...args) as Row[];
      return rows.map(row => this.finishReply(row,"cancelled",now,parsed.reason));
    })();
  }
  expiredLeases(now: number): Reply[] {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite.query("SELECT * FROM replies WHERE state='leased' AND lease_until<=? ORDER BY id").all(now) as Row[];
      return rows.map(row => {
        if (bool(row.lease_commit) && row.committed_at == null) {
          this.sqlite.query(`UPDATE replies SET state='queued',lease_until=NULL,done_at=NULL,lease_commit=NULL
            WHERE id=? AND state='leased' AND committed_at IS NULL`).run(row.id);
          return this.reply({ ...row,state:"queued",lease_until:null,done_at:null,lease_commit:null })!;
        }
        return this.finishReply(row,"delivered",now,null,true);
      });
    })();
  }
  pruneReplies(now: number): number {
    const cutoff = now - 90 * 86400_000;
    return this.sqlite.transaction(() => this.sqlite.query(`DELETE FROM replies WHERE id IN (
      SELECT id FROM replies WHERE state IN ('delivered','expired','cancelled') AND COALESCE(done_at,created_at)<?
      ORDER BY COALESCE(done_at,created_at),id LIMIT 500
    )`).run(cutoff).changes)();
  }
  replyCounts(): Record<ReplyState, number> {
    const counts: Record<ReplyState,number> = {queued:0,leased:0,delivered:0,expired:0,cancelled:0};
    for (const row of this.sqlite.query("SELECT state,COUNT(*) AS n FROM replies GROUP BY state").all() as Row[]) counts[row.state as ReplyState]=n(row.n);
    return counts;
  }
  rememberAlert(chatId: string, msgId: number, key: string | null, kind: AlertKind, now: number): void {
    this.sqlite.transaction(() => {
      this.sqlite.query("INSERT OR REPLACE INTO tg_alerts(chat_id,message_id,session_key,kind,sent_at) VALUES(?,?,?,?,?)").run(chatId,msgId,value(key),kind,now);
      this.sqlite.query("DELETE FROM tg_alerts WHERE sent_at<?").run(now-7*86400_000);
    })();
  }
  alertFor(chatId: string, msgId: number): {sessionKey:string|null; kind:AlertKind} | undefined {
    const row = this.sqlite.query("SELECT session_key,kind FROM tg_alerts WHERE chat_id=? AND message_id=?").get(chatId,msgId) as Row | null;
    return row ? {sessionKey:s(row.session_key) ?? null,kind:row.kind as AlertKind} : undefined;
  }
  rememberTelegramQuestionMessage(message: TelegramQuestionMessage): void {
    this.sqlite.query("DELETE FROM tg_question_messages WHERE created_at<?").run(message.createdAt-7*86400_000);
    this.sqlite.query(`INSERT OR REPLACE INTO tg_question_messages
      (question_id,session_key,chat_id,thread_id,message_id,question_index,created_at,is_prompt) VALUES(?,?,?,?,?,?,?,?)`)
      .run(message.questionId,message.sessionKey,message.chatId,message.threadId,message.messageId,message.questionIndex,message.createdAt,Number(message.prompt));
  }
  private telegramQuestionMessageRow(row: Row): TelegramQuestionMessage {
    return {
      questionId:String(row.question_id),sessionKey:String(row.session_key),chatId:String(row.chat_id),
      threadId:row.thread_id == null ? null : n(row.thread_id),messageId:n(row.message_id),
      questionIndex:n(row.question_index),createdAt:n(row.created_at),prompt:n(row.is_prompt) === 1,
    };
  }
  telegramQuestionMessage(chatId: string, messageId: number): TelegramQuestionMessage | undefined {
    const row = this.sqlite.query("SELECT * FROM tg_question_messages WHERE chat_id=? AND message_id=?")
      .get(chatId,messageId) as Row | null;
    return row ? this.telegramQuestionMessageRow(row) : undefined;
  }
  telegramQuestionMessages(sessionKey?: string): TelegramQuestionMessage[] {
    const rows = (sessionKey === undefined
      ? this.sqlite.query("SELECT * FROM tg_question_messages ORDER BY created_at").all()
      : this.sqlite.query("SELECT * FROM tg_question_messages WHERE session_key=? ORDER BY created_at").all(sessionKey)) as Row[];
    return rows.map(row => this.telegramQuestionMessageRow(row));
  }
  telegramQuestionMessagesForQuestion(questionId: string): TelegramQuestionMessage[] {
    return (this.sqlite.query("SELECT * FROM tg_question_messages WHERE question_id=? ORDER BY question_index")
      .all(questionId) as Row[]).map(row => this.telegramQuestionMessageRow(row));
  }
  deleteTelegramQuestionMessage(chatId: string,messageId: number): void {
    this.sqlite.query("DELETE FROM tg_question_messages WHERE chat_id=? AND message_id=?").run(chatId,messageId);
  }
  private cardRow(where: string, ...args: (string | number)[]): Row | null {
    return this.sqlite.query(`SELECT c.*,r.text,r.decisions_json FROM tg_cards c LEFT JOIN responses r ON r.id=c.response_id WHERE ${where}`).get(...args) as Row | null;
  }
  private card(row: Row | null): Card | undefined {
    if (!row) return undefined;
    const decisions = this.decisions(row.decisions_json, row.text) ?? { decisions: [], source: "parser" };
    let picks: Record<string, number> | null = null;
    try { picks = validPicks(JSON.parse(String(row.picks_json)), decisions); } catch { picks = null; }
    return { id: n(row.id), sessionKey: String(row.session_key), responseId: n(row.response_id), turnSeq: n(row.turn_seq),
      chatId: String(row.chat_id), threadId: row.thread_id == null ? null : n(row.thread_id),
      messageId: row.message_id == null ? null : n(row.message_id), picks, state: row.state as CardState,
      replyId: row.reply_id == null ? null : n(row.reply_id), createdAt: n(row.created_at), expiresAt: n(row.expires_at), decisions };
  }
  // One card per (session, turn); a repeat returns the existing row, except that a failed card (its message never went
  // out or went to an old pairing) is replaced. Ids beyond 8 base36 characters are never created.
  createCardIntent(key: string, responseId: number, turnSeq: number, place: { chatId: string; threadId: number | null },
    now: number): { created: boolean; card: Card } | "card_id_overflow" {
    try {
      return this.sqlite.transaction(() => {
        const existing = this.cardForTurn(key, turnSeq);
        if (existing?.state === "failed") this.sqlite.query("DELETE FROM tg_cards WHERE id=? AND state='failed'").run(existing.id);
        else if (existing) return { created: false, card: existing };
        const id = Number(this.sqlite.query(`INSERT INTO tg_cards(session_key,response_id,turn_seq,chat_id,thread_id,state,created_at,expires_at)
          VALUES(?,?,?,?,?,'pending',?,?)`).run(key, responseId, turnSeq, place.chatId, value(place.threadId), now, now + CARD_TTL_MS).lastInsertRowid);
        if (id.toString(36).length > 8) throw new CardIdOverflow();
        return { created: true, card: this.getCard(id)! };
      })();
    } catch (error) {
      if (error instanceof CardIdOverflow) return "card_id_overflow";
      throw error;
    }
  }
  activateCard(id: number, place: { chatId: string; threadId: number | null; messageId: number }): boolean {
    return this.sqlite.query("UPDATE tg_cards SET state='active',chat_id=?,thread_id=?,message_id=? WHERE id=? AND state='pending'")
      .run(place.chatId, value(place.threadId), place.messageId, id).changes === 1;
  }
  repointCard(id: number, place: { chatId: string; threadId: number | null; messageId: number }): boolean {
    return this.sqlite.query("UPDATE tg_cards SET chat_id=?,thread_id=?,message_id=? WHERE id=? AND state IN ('pending','active')")
      .run(place.chatId, value(place.threadId), place.messageId, id).changes === 1;
  }
  getCard(id: number): Card | undefined { return this.card(this.cardRow("c.id=?", id)); }
  cardForReply(replyId: number): Card | undefined { return this.card(this.cardRow("c.reply_id=? ORDER BY c.id DESC LIMIT 1", replyId)); }
  cardForTurn(key: string, turnSeq: number): Card | undefined { return this.card(this.cardRow("c.session_key=? AND c.turn_seq=?", key, turnSeq)); }
  togglePick(id: number, decision: number, option: number): Card | undefined {
    return this.sqlite.transaction(() => {
      const card = this.card(this.cardRow(`c.id=? AND c.state='active'
        AND c.turn_seq=(SELECT s.turn_seq FROM sessions s WHERE s.key=c.session_key)`, id));
      const options = card?.decisions.decisions[decision]?.options;
      if (!card?.picks || !options || !Number.isInteger(option) || option < 0 || option >= options.length) return undefined;
      const picks = { ...card.picks }, slot = String(decision);
      if (picks[slot] === option) delete picks[slot]; else picks[slot] = option;
      const changes = this.sqlite.query("UPDATE tg_cards SET picks_json=? WHERE id=? AND state='active'").run(JSON.stringify(picks), id).changes;
      return changes === 1 ? { ...card, picks } : undefined;
    })();
  }
  markCardSent(id: number, replyId: number): boolean {
    return this.sqlite.query("UPDATE tg_cards SET state='sent',reply_id=? WHERE id=? AND state='active'").run(replyId, id).changes === 1;
  }
  markCardState(id: number, state: CardState, from: CardState[] = ["pending", "active"]): boolean {
    return this.sqlite.query("UPDATE tg_cards SET state=? WHERE id=? AND state IN (SELECT value FROM json_each(?))")
      .run(state, id, JSON.stringify(from)).changes === 1;
  }
  // A card still pending past the grace whose send is not in flight in this process was stranded by a crash or shutdown.
  failStrandedCards(before: number, inFlight: number[] = []): number {
    return this.sqlite.query(`UPDATE tg_cards SET state='failed' WHERE state='pending' AND created_at<?
      AND id NOT IN (SELECT value FROM json_each(?))`).run(before, JSON.stringify(inFlight)).changes;
  }
  // Unpairing ends every live card; its taps answer Expired.
  expireLiveCards(): number {
    return this.sqlite.query("UPDATE tg_cards SET state='expired' WHERE state IN ('pending','active')").run().changes;
  }
  pruneCards(now: number): number {
    return this.sqlite.transaction(() => {
      this.sqlite.query("UPDATE tg_cards SET state='expired' WHERE state IN ('pending','active') AND expires_at<=?").run(now);
      return this.sqlite.query(`DELETE FROM tg_cards WHERE id IN (
        SELECT id FROM tg_cards WHERE expires_at<? ORDER BY expires_at,id LIMIT 500
      )`).run(now - 7 * 86400_000).changes;
    })();
  }
  latestQuestionDetail(key: string): string | undefined {
    const detail = s((this.sqlite.query("SELECT detail FROM events WHERE session_key=? AND kind='question' ORDER BY id DESC LIMIT 1").get(key) as Row | null)?.detail);
    if (!detail) return undefined;
    try {
      const parsed: unknown = JSON.parse(detail);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("questions" in parsed)) return detail;
      const questions = normalizeQuestions(parsed.questions);
      if (questions) return JSON.stringify(questions.map(question => question.options.map((option, index) => ({
        ...option,
        label: question.multi !== true && index === question.recommended && !option.label.endsWith(" (Recommended)")
          ? `${option.label} (Recommended)` : option.label,
      }))));
    } catch { /* Older Claude question details keep their existing JSON representation. */ }
    return detail;
  }
  latestPromptEventId(key: string): number {
    return n((this.sqlite.query("SELECT MAX(id) AS id FROM events WHERE session_key=? AND kind='prompt'").get(key) as Row).id);
  }
  pendingAlertUpdates(now: number): { chatId: string; messageId: number; content: string; expiresAt: number }[] {
    return (this.sqlite.query("SELECT chat_id,message_id,content,sent_at FROM tg_alerts WHERE content IS NOT NULL AND sent_at>=?")
      .all(now-7*86400_000) as Row[]).map(row => ({
        chatId: String(row.chat_id), messageId: n(row.message_id), content: String(row.content), expiresAt: n(row.sent_at)+7*86400_000,
      }));
  }
  setAlertContent(chatId: string, messageId: number, content: string | null): void {
    this.sqlite.query("UPDATE tg_alerts SET content=? WHERE chat_id=? AND message_id=?").run(content,chatId,messageId);
  }
  clearAlertUpdates(): void { this.sqlite.query("UPDATE tg_alerts SET content=NULL WHERE content IS NOT NULL").run(); }
  startUrgentEpisode(key: string, startedAt: number): void {
    this.sqlite.query(`INSERT INTO tg_urgent_episodes(session_key,started_at,repaged_at) VALUES(?,?,NULL)
      ON CONFLICT(session_key) DO UPDATE SET started_at=excluded.started_at,repaged_at=NULL`).run(key,startedAt);
  }
  hasUrgentEpisode(key: string): boolean { return !!this.sqlite.query("SELECT 1 FROM tg_urgent_episodes WHERE session_key=?").get(key); }
  endUrgentEpisode(key: string): void { this.sqlite.query("DELETE FROM tg_urgent_episodes WHERE session_key=?").run(key); }
  dueUrgentEpisodes(now: number, thresholdMs: number): { sessionKey: string; startedAt: number; repagedAt: number | null }[] {
    return (this.sqlite.query(`SELECT session_key,started_at,repaged_at FROM tg_urgent_episodes
      WHERE repaged_at IS NULL AND started_at + ? < ? ORDER BY started_at,session_key`).all(thresholdMs,now) as Row[])
      .map(row => ({ sessionKey:String(row.session_key), startedAt:n(row.started_at), repagedAt:row.repaged_at == null ? null : n(row.repaged_at) }));
  }
  markUrgentRepaged(key: string, now: number): boolean {
    return this.sqlite.query("UPDATE tg_urgent_episodes SET repaged_at=? WHERE session_key=? AND repaged_at IS NULL").run(now,key).changes === 1;
  }
  countSessions(): number { return n((this.sqlite.query("SELECT COUNT(*) AS n FROM sessions").get() as Row).n); }
  countResponses(): number { return n((this.sqlite.query("SELECT COUNT(*) AS n FROM responses").get() as Row).n); }
  private getRow(key: string): Row | null { return this.sqlite.query("SELECT * FROM sessions WHERE key=?").get(key) as Row | null; }
  private questionAnswered(key: string, identity: string): boolean {
    return !!this.sqlite.query("SELECT 1 FROM events WHERE session_key=? AND kind='question_answered' AND detail=? LIMIT 1")
      .get(key, JSON.stringify({ questionIdentity: identity }));
  }
  private questionInvocation(row: Row | null): QuestionInvocation | undefined {
    if (!row) return undefined;
    let questions: AskQuestion[] | undefined;
    try { questions = normalizeQuestions(JSON.parse(String(row.questions_json))); } catch {}
    if (!questions) return undefined;
    let answers: Record<string, string> | undefined;
    if (typeof row.answers_json === "string") {
      try {
        const parsed: unknown = JSON.parse(row.answers_json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
            Object.values(parsed).every(answer => typeof answer === "string") &&
            Object.keys(parsed).length === questions.length &&
            questions.every(question => Object.hasOwn(parsed, question.question))) answers = parsed as Record<string, string>;
      } catch {}
    }
    return {
      id: String(row.question_id), sessionKey: String(row.session_key), toolUseId: String(row.tool_use_id),
      questions, state: row.state as QuestionInvocationState, answers,
      source: s(row.source) as ReplySource | undefined, actor: s(row.actor), listener: s(row.listener) as ReplyAuditListener | undefined,
      createdAt: n(row.created_at), expiresAt: n(row.expires_at),
      answeredAt: row.answered_at == null ? undefined : n(row.answered_at),
      lastHookEventAt: row.session_last_hook_event_ts == null ? undefined : n(row.session_last_hook_event_ts),
      doneAt: row.done_at == null ? undefined : n(row.done_at), cancelReason: s(row.cancel_reason),
    };
  }
  getQuestionInvocation(id: string, key?: string, toolUseId?: string): QuestionInvocation | undefined {
    const clauses = ["question_id=?"], args: unknown[] = [id];
    if (key !== undefined) { clauses.push("session_key=?"); args.push(key); }
    if (toolUseId !== undefined) { clauses.push("tool_use_id=?"); args.push(toolUseId); }
    return this.questionInvocation(this.sqlite.query(`SELECT * FROM question_invocations WHERE ${clauses.join(" AND ")}`).get(...args) as Row | null);
  }
  questionForToolUse(key: string, toolUseId: string): QuestionInvocation | undefined {
    return this.questionInvocation(this.sqlite.query("SELECT * FROM question_invocations WHERE session_key=? AND tool_use_id=?")
      .get(key, toolUseId) as Row | null);
  }
  questionInvocationsForSession(key: string): QuestionInvocation[] {
    return (this.sqlite.query(`SELECT q.*,s.last_hook_event_ts AS session_last_hook_event_ts
      FROM question_invocations q JOIN sessions s ON s.key=q.session_key
      WHERE q.session_key=? AND q.state IN ('pending','answered') ORDER BY q.created_at`)
      .all(key) as Row[]).map(row => this.questionInvocation(row)!).filter((invocation): invocation is QuestionInvocation => !!invocation);
  }
  registerQuestion(event: NormalizedEvent, id: string, toolUseId: string, questions: AskQuestion[],
    now: number, ttlMs: number): QuestionRegistration {
    const key = sessionKey(event);
    if (this.getSession(key)?.status === "ended") return { ok: false, reason: "session_ended" };
    if (this.getQuestionInvocation(id) || this.questionForToolUse(key, toolUseId)) return { ok: false, reason: "duplicate" };
    this.applyEvent({ ...event, questionIdentity: id, toolUseId, questionData: questions });
    const replaced = this.sqlite.transaction(() => {
      const old = this.sqlite.query("SELECT question_id FROM question_invocations WHERE session_key=? AND state IN ('pending','answered')")
        .all(key) as Row[];
      this.sqlite.query(`UPDATE question_invocations SET state='cancelled',answers_json=NULL,done_at=?,cancel_reason='replaced'
        WHERE session_key=? AND state IN ('pending','answered')`).run(now,key);
      this.sqlite.query(`INSERT INTO question_invocations
        (question_id,session_key,tool_use_id,questions_json,state,created_at,expires_at)
        VALUES(?,?,?,?,'pending',?,?)`).run(id,key,toolUseId,JSON.stringify(questions),now,now+ttlMs);
      return old.map(row => String(row.question_id));
    })();
    return { ok: true, dto: this.getSession(key)!, replaced };
  }
  answerQuestion(id: string, key: string, toolUseId: string, answers: Record<string, string>,
    source: ReplySource, actor: string, listener: ReplyAuditListener, now: number,
    auditContext: PreparedAuditContext): "accepted" | "stale" | "expired" | "ended" {
    const result = this.sqlite.transaction(() => {
      const row = this.sqlite.query(`SELECT q.*,s.status AS session_status,s.pending_question_id
        FROM question_invocations q JOIN sessions s ON s.key=q.session_key
        WHERE q.question_id=? AND q.session_key=? AND q.tool_use_id=?`).get(id,key,toolUseId) as Row | null;
      if (!row || row.state !== "pending" || String(row.pending_question_id) !== id) return "stale" as const;
      if (row.session_status === "ended") return "ended" as const;
      if (n(row.expires_at) <= now) return "expired" as const;
      if (auditContext.sessionKey !== key || auditContext.source !== source || auditContext.actor !== actor ||
          auditContext.listener !== listener) throw new Error("question audit context mismatch");
      const changed = this.sqlite.query(`UPDATE question_invocations SET state='answered',answers_json=?,source=?,actor=?,listener=?,answered_at=?
        WHERE question_id=? AND state='pending' AND expires_at>?`).run(JSON.stringify(answers),source,actor,listener,now,id,now).changes;
      if (changed !== 1) return "stale" as const;
      this.insertAuditRow(this.auditEntryFromContext(auditContext,null));
      return "accepted" as const;
    })();
    if (result === "expired") this.finishQuestion(id,key,toolUseId,now,"expired","expired");
    if (result === "accepted") {
      const dto = this.getSession(key);
      if (dto) this.applyEvent({ host:dto.host,harness:"claude",sessionId:dto.sessionId,kind:"question_answered",
        ts:now,interactive:dto.interactive,cwd:dto.cwd,title:dto.title,transcriptPath:dto.transcriptPath,
        sessionKind:dto.sessionKind,questionIdentity:id,toolUseId });
    }
    return result;
  }
  consumeQuestion(id: string, key: string, toolUseId: string, now: number):
    { kind: "pending" | "stale" | "expired" | "ended" } | { kind: "taken"; answers: Record<string, string> } {
    const invocation = this.getQuestionInvocation(id,key,toolUseId);
    if (!invocation || invocation.state !== "pending" && invocation.state !== "answered") return { kind: "stale" };
    if (invocation.expiresAt <= now) {
      this.finishQuestion(id,key,toolUseId,now,"expired","expired");
      return { kind: "expired" };
    }
    const dto = this.getSession(key);
    if (!dto || dto.status === "ended") {
      this.finishQuestion(id,key,toolUseId,now,"cancelled","session_ended");
      return { kind: "ended" };
    }
    if (invocation.state === "pending") return { kind: "pending" };
    if (!invocation.answers) {
      this.finishQuestion(id,key,toolUseId,now,"cancelled","invalid_answers");
      return { kind: "stale" };
    }
    const consumed = this.sqlite.transaction(() => this.sqlite.query(`UPDATE question_invocations
      SET state='consumed',answers_json=NULL,done_at=?,cancel_reason=NULL
      WHERE question_id=? AND session_key=? AND tool_use_id=? AND state='answered' AND expires_at>?`)
      .run(now,id,key,toolUseId,now).changes === 1)();
    return consumed ? { kind: "taken", answers: invocation.answers } : { kind: "stale" };
  }
  private finishQuestion(id: string, key: string, toolUseId: string, now: number,
    state: "cancelled" | "expired", reason: string): SessionDTO | null {
    const changed = this.sqlite.transaction(() => {
      const row = this.sqlite.query(`SELECT q.*,s.status AS session_status,s.pending_question_id,s.last_hook_event_ts
        FROM question_invocations q JOIN sessions s ON s.key=q.session_key
        WHERE q.question_id=? AND q.session_key=? AND q.tool_use_id=?`).get(id,key,toolUseId) as Row | null;
      if (!row || row.state !== "pending" && row.state !== "answered") return false;
      const updated = this.sqlite.query(`UPDATE question_invocations SET state=?,answers_json=NULL,done_at=?,cancel_reason=?
        WHERE question_id=? AND state IN ('pending','answered')`).run(state,now,reason,id).changes === 1;
      if (!updated || row.session_status === "ended") return updated;
      let fallbackText: string | undefined;
      const answeredFallback = row.state === "answered" && row.session_status === "working" &&
        n(row.last_hook_event_ts) <= n(row.answered_at);
      if (answeredFallback) {
        try {
          const questions = normalizeQuestions(JSON.parse(String(row.questions_json)));
          fallbackText = questions?.map(question => question.question).join("\n");
        } catch {}
      }
      if (String(row.pending_question_id) === id) {
        this.sqlite.query("UPDATE sessions SET last_activity=? WHERE key=?").run(now,key);
      } else if (answeredFallback && fallbackText) {
        this.sqlite.query(`UPDATE sessions SET status='needs_input',needs_reason='question',needs_text=?,pending_question_id=?,last_activity=?
          WHERE key=? AND status='working' AND last_hook_event_ts<=?`)
          .run(fallbackText,id,now,key,n(row.answered_at));
      }
      return true;
    })();
    return changed ? this.getSession(key) : null;
  }
  cancelQuestion(id: string, key: string, toolUseId: string, now: number, reason: string): SessionDTO | null {
    return this.finishQuestion(id,key,toolUseId,now,"cancelled",reason);
  }
  expireQuestions(now: number): { id: string; key: string; toolUseId: string; dto: SessionDTO }[] {
    const rows = this.sqlite.query("SELECT question_id,session_key,tool_use_id FROM question_invocations WHERE state IN ('pending','answered') AND expires_at<=?")
      .all(now) as Row[];
    const expired: { id: string; key: string; toolUseId: string; dto: SessionDTO }[] = [];
    for (const row of rows) {
      const id = String(row.question_id), key = String(row.session_key), toolUseId = String(row.tool_use_id);
      const dto = this.finishQuestion(id,key,toolUseId,now,"expired","expired");
      if (dto) expired.push({ id,key,toolUseId,dto });
    }
    return expired;
  }
  cancelQuestionsForSession(key: string, now: number, reason: string): { id: string; toolUseId: string; dto: SessionDTO }[] {
    const rows = this.sqlite.query("SELECT question_id,tool_use_id FROM question_invocations WHERE session_key=? AND state IN ('pending','answered')")
      .all(key) as Row[];
    const cancelled: { id: string; toolUseId: string; dto: SessionDTO }[] = [];
    for (const row of rows) {
      const id = String(row.question_id), toolUseId = String(row.tool_use_id);
      const dto = this.finishQuestion(id,key,toolUseId,now,"cancelled",reason);
      if (dto) cancelled.push({ id,toolUseId,dto });
    }
    return cancelled;
  }
  pruneQuestions(now: number): number {
    return this.sqlite.query("DELETE FROM question_invocations WHERE state IN ('consumed','cancelled','expired') AND done_at<?")
      .run(now-7*86400_000).changes;
  }
  private invalidateInterruptedQuestions(now: number): void {
    const rows = this.sqlite.query(`SELECT q.question_id,q.session_key,q.state,q.answered_at,q.questions_json,
      s.status AS session_status,s.pending_question_id,s.last_hook_event_ts
      FROM question_invocations q JOIN sessions s ON s.key=q.session_key WHERE q.state IN ('pending','answered')`).all() as Row[];
    for (const row of rows) {
      const id = String(row.question_id), key = String(row.session_key);
      this.sqlite.query(`UPDATE question_invocations SET state='cancelled',answers_json=NULL,done_at=?,cancel_reason='hub_restarted'
        WHERE question_id=? AND state IN ('pending','answered')`).run(now,id);
      if (String(row.pending_question_id) === id) {
        this.sqlite.query("UPDATE sessions SET last_activity=? WHERE key=?").run(now,key);
      } else if (row.state === "answered" && row.session_status === "working" && n(row.last_hook_event_ts) <= n(row.answered_at)) {
        let text: string | undefined;
        try { text = normalizeQuestions(JSON.parse(String(row.questions_json)))?.map(question => question.question).join("\n"); } catch {}
        if (text) this.sqlite.query(`UPDATE sessions SET status='needs_input',needs_reason='question',needs_text=?,pending_question_id=?,last_activity=?
          WHERE key=? AND status='working' AND last_hook_event_ts<=?`).run(text,id,now,key,n(row.answered_at));
      }
    }
    this.sqlite.query("DELETE FROM question_invocations WHERE state IN ('consumed','cancelled','expired') AND done_at<?")
      .run(now-7*86400_000);
  }
  private ensure(event: Pick<NormalizedEvent, "host" | "harness" | "sessionId" | "ts" | "cwd" | "title" | "interactive" | "transcriptPath" | "sessionKind">): Row {
    const key = sessionKey(event);
    this.sqlite.query(`INSERT OR IGNORE INTO sessions
      (key,host,harness,session_id,cwd,title,interactive,transcript_path,session_kind,created_at,last_activity)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(key, event.host, event.harness, event.sessionId, value(event.cwd), value(event.title), event.interactive ? 1 : 0, value(event.transcriptPath), value(event.sessionKind), event.ts, event.ts);
    return this.getRow(key)!;
  }
  applyEvent(event: NormalizedEvent): SessionDTO {
    const key = sessionKey(event);
    const invocation = event.harness === "claude" && event.toolUseId ? this.questionForToolUse(key,event.toolUseId) : undefined;
    const current = invocation ? { ...event, questionIdentity: invocation.id } : event;
    this.sqlite.transaction(() => {
      const row = this.ensure(current);
      const previous: SessionState = {
        status: row.status as Status, needsReason: s(row.needs_reason), needsText: s(row.needs_text),
        pendingQuestionId: s(row.pending_question_id),
        lastPrompt: s(row.last_prompt), lastError: s(row.last_error), lastNotification: s(row.last_notification),
        backgroundPending: bool(row.background_pending), lastActivity: n(row.last_activity),
      };
      const answeredBeforeStart = current.kind === "question" && current.questionIdentity
        ? this.questionAnswered(key, current.questionIdentity)
        : false;
      const next = answeredBeforeStart ? { ...previous, lastActivity: current.ts } : reduceState(previous, current);
      const questionDetail = current.kind === "question" && current.questionData && current.questionIdentity
        ? JSON.stringify({ questionIdentity: current.questionIdentity, questions: current.questionData })
        : current.kind === "question_answered" && current.questionIdentity
          ? JSON.stringify({ questionIdentity: current.questionIdentity })
          : value(current.detail);
      this.sqlite.query(`UPDATE sessions SET cwd=COALESCE(?,cwd), title=COALESCE(?,title),
        interactive=?, transcript_path=COALESCE(?,transcript_path), session_kind=COALESCE(NULLIF(?,''),session_kind),
        status=?, needs_reason=?, needs_text=?, pending_question_id=?, last_prompt=?, last_error=?, last_notification=?,
        background_pending=?, last_activity=?, last_hook_event_ts=?, turn_seq=turn_seq+? WHERE key=?`).run(
        value(current.cwd), value(current.title), current.interactive ? 1 : 0, value(current.transcriptPath), value(current.sessionKind),
        next.status, value(next.needsReason), value(next.needsText), value(next.pendingQuestionId), value(next.lastPrompt), value(next.lastError),
        value(next.lastNotification), next.backgroundPending ? 1 : 0, next.lastActivity, current.ts,
        current.kind === "response" || current.kind === "error" ? 1 : 0, key);
      this.sqlite.query("INSERT INTO events(session_key,ts,kind,detail) VALUES(?,?,?,?)").run(key, current.ts, current.kind, questionDetail);
      if (current.kind === "response" && current.text?.trim()) {
        this.insertResponse(key, clip(current.text)!, describePrompt(next.lastPrompt), current.ts, "hook", n(row.turn_seq) + 1);
      }
      this.sqlite.query("DELETE FROM events WHERE ts<?").run(Date.now() - 7 * 86400_000);
    })();
    return this.getSession(key)!;
  }
  private decide(text: string, source: "hook" | "backfill"): { json: string | null; state: DecisionState } {
    if (!this.decisionsEnabled) return { json: null, state: "skipped" };
    const set = extractDecisions(text);
    if (set.decisions.length) return { json: JSON.stringify(set), state: "parser" };
    if (this.judgeEnabled && source === "hook" && looksDecisionLike(text)) return { json: null, state: "pending" };
    return { json: JSON.stringify(set), state: "none" };
  }
  private insertResponse(key: string, text: string, prompt: string | null, ts: number, source: "hook" | "backfill",
    turnSeq: number | null): { inserted: boolean; id: number; state: DecisionState } | undefined {
    if (!text.trim()) return undefined;
    const digest = hash(text);
    const lastFive = this.sqlite.query("SELECT id,text_sha1,decision_state,turn_seq FROM responses WHERE session_key=? ORDER BY ts DESC,id DESC LIMIT 5").all(key) as Row[];
    const match = lastFive.find(row => row.text_sha1 === digest);
    if (match) {
      const id = n(match.id);
      let state = String(match.decision_state) as DecisionState;
      if (source !== "hook") return { inserted: false, id, state };
      // A hook duplicate answers a new turn: rebind the exact matched row and reuse its decisions.
      if (!this.decisionsEnabled) {
        this.sqlite.query("UPDATE responses SET turn_seq=? WHERE id=?").run(value(turnSeq), id);
        return { inserted: false, id, state };
      }
      const decided = state === "skipped" || state === "none" && match.turn_seq == null ? this.decide(text, "hook") : undefined;
      const bumped = Math.max(ts, this.lastResponseTs + 1);
      this.lastResponseTs = bumped;
      // The row now answers a live hook turn, so it carries the hook source (A2 button, cards, Luna results).
      this.sqlite.query("UPDATE responses SET turn_seq=?,ts=?,source='hook' WHERE id=?").run(value(turnSeq), bumped, id);
      if (decided) {
        this.sqlite.query("UPDATE responses SET decisions_json=?,decision_state=? WHERE id=?").run(decided.json, decided.state, id);
        state = decided.state;
      }
      return { inserted: false, id, state };
    }
    const { json, state } = this.decide(text, source);
    let responseTs = source === "hook" ? Math.max(ts, this.lastResponseTs + 1) : ts;
    if (source === "backfill") while (this.sqlite.query("SELECT 1 FROM responses WHERE ts=? LIMIT 1").get(responseTs)) responseTs++;
    this.lastResponseTs = Math.max(responseTs, this.lastResponseTs);
    const result = this.sqlite.query(`INSERT INTO responses(session_key,ts,text,prompt,seen,source,text_sha1,decisions_json,decision_state,turn_seq)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(key, responseTs, text, value(prompt), source === "backfill" ? 1 : 0, source, digest, json, state, value(turnSeq));
    return { inserted: true, id: Number(result.lastInsertRowid), state };
  }
  // Stored JSON is re-validated against its own response text; anything malformed surfaces as null.
  private decisions(json: unknown, text: unknown): DecisionSet | null {
    if (json == null) return null;
    try {
      const raw = JSON.parse(String(json));
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.decisions) || raw.source !== "parser" && raw.source !== "luna") return null;
      return raw.decisions.length ? validateDecisionSet(raw, String(text ?? ""), raw.source) : { decisions: [], source: raw.source };
    } catch { return null; }
  }
  private response(row: Row, sessionCwd?: string): ResponseDTO {
    const cwd = s(row.cwd) ?? sessionCwd;
    return { id: n(row.id), sessionKey: String(row.session_key), ts: n(row.ts), text: String(row.text),
      prompt: s(row.prompt), seen: bool(row.seen), source: row.source as "hook" | "backfill",
      displayName: s(row.display_name), host: s(row.host), harness: row.harness as Harness | undefined,
      sessionId: s(row.session_id), cwd, project: this.topicsEnabled ? resolveProject(cwd, this.projectRulesState.rules) : (cwd ? basename(cwd) : ""),
      decisions: this.decisions(row.decisions_json, row.text),
      decisionState: (s(row.decision_state) ?? "skipped") as DecisionState, turnSeq: row.turn_seq == null ? null : n(row.turn_seq),
      ...(this.decisionsEnabled ? { recommendation: recommendationQuote(String(row.text)) } : {}) };
  }
  getResponse(id: number): ResponseDTO | undefined {
    const row = this.sqlite.query(`SELECT r.*,s.cwd,s.display_name,s.title,s.host,s.harness,s.session_id
      FROM responses r JOIN sessions s ON s.key=r.session_key WHERE r.id=?`).get(id) as Row | null;
    return row ? this.response(row) : undefined;
  }
  responseForTurn(key: string, turnSeq: number): ResponseDTO | undefined {
    const row = this.sqlite.query(`SELECT r.*,s.cwd,s.display_name,s.title,s.host,s.harness,s.session_id
      FROM responses r JOIN sessions s ON s.key=r.session_key
      WHERE r.session_key=? AND r.turn_seq=? ORDER BY r.ts DESC,r.id DESC LIMIT 1`).get(key, turnSeq) as Row | null;
    return row ? this.response(row) : undefined;
  }
  setDecisionsIfPending(id: number, set: DecisionSet, state: "luna" | "none" | "failed"): number {
    return this.sqlite.query("UPDATE responses SET decisions_json=?,decision_state=? WHERE id=? AND decision_state='pending'")
      .run(JSON.stringify(set), state, id).changes;
  }
  // Pending rows stay pending only while they are the session's current hook turn from the last 24 h and the judge is on.
  resumablePending(now: number): number[] {
    const fresh = `?1=1 AND turn_seq IS NOT NULL AND ts>=?2 AND turn_seq=(SELECT s.turn_seq FROM sessions s WHERE s.key=responses.session_key)`;
    const live = this.judgeEnabled ? 1 : 0, since = now - 86_400_000;
    return this.sqlite.transaction(() => {
      const ids = (this.sqlite.query(`SELECT id FROM responses WHERE decision_state='pending' AND ${fresh} ORDER BY id`).all(live, since) as Row[]).map(row => n(row.id));
      this.sqlite.query(`UPDATE responses SET decision_state='none',decisions_json=?3 WHERE decision_state='pending' AND NOT (${fresh})`)
        .run(live, since, JSON.stringify({ decisions: [], source: "parser" }));
      return ids;
    })();
  }
  private pendingQuestion(row: Row): PendingQuestion | undefined {
    if (row.status !== "needs_input" || row.needs_reason !== "question") return undefined;
    const id = s(row.pending_question_id), key = String(row.key);
    if (!id) return undefined;
    if (row.harness === "claude") {
      const invocation = this.getQuestionInvocation(id,key);
      return invocation?.state === "pending" && invocation.expiresAt > Date.now()
        ? { id, questions: invocation.questions } : undefined;
    }
    if (row.harness !== "omp" || this.questionAnswered(key,id)) return undefined;
    const event = this.sqlite.query("SELECT detail FROM events WHERE session_key=? AND kind='question' ORDER BY id DESC LIMIT 1")
      .get(key) as Row | null;
    try {
      const detail: unknown = JSON.parse(String(event?.detail));
      if (!detail || typeof detail !== "object" || Array.isArray(detail) ||
          !("questionIdentity" in detail) || !("questions" in detail) || detail.questionIdentity !== id) return undefined;
      const questions = normalizeQuestions(detail.questions);
      return questions ? { id, questions } : undefined;
    } catch { return undefined; }
  }
  private dto(row: Row): SessionDTO {
    const key = String(row.key);
    const responses = this.sqlite.query("SELECT * FROM responses WHERE session_key=? ORDER BY ts DESC,id DESC LIMIT 3").all(key) as Row[];
    const unread = this.sqlite.query("SELECT COUNT(*) AS n FROM responses WHERE session_key=? AND seen=0").get(key) as Row;
    const cwd = s(row.cwd);
    return {
      key, host: String(row.host), harness: row.harness as Harness, sessionId: String(row.session_id),
      cwd, title: s(row.title), displayName: s(row.display_name) || s(row.title) || (cwd ? basename(cwd) : String(row.session_id)),
      project: this.topicsEnabled ? resolveProject(cwd, this.projectRulesState.rules) : (cwd ? basename(cwd) : ""),
      status: row.status as Status, needsReason: s(row.needs_reason),
      needsText: s(row.needs_text), pendingQuestionId: s(row.pending_question_id), pendingQuestion: this.pendingQuestion(row), lastPrompt: s(row.last_prompt), lastError: s(row.last_error),
      lastNotification: s(row.last_notification), backgroundPending: bool(row.background_pending),
      interactive: bool(row.interactive), alive: bool(row.alive), pid: row.pid == null ? undefined : n(row.pid),
      transcriptPath: s(row.transcript_path), createdAt: n(row.created_at), lastActivity: n(row.last_activity),
      unreadCount: n(unread.n), lastResponses: responses.map((r) => this.response(r, cwd)), sessionKind: s(row.session_kind),
      turnSeq:n(row.turn_seq),
    };
  }
  getSession(key: string): SessionDTO | null { const row = this.getRow(key); return row ? this.dto(row) : null; }
  listSessions(headless = false, ended = false): SessionDTO[] {
    const rows = this.sqlite.query("SELECT * FROM sessions WHERE (?=1 OR interactive=1) AND (?=1 OR status!='ended') ORDER BY last_activity DESC").all(headless ? 1 : 0, ended ? 1 : 0) as Row[];
    return rows.map((r) => this.dto(r));
  }
  timeline(limit = 100, before?: number, headless = false, host = "", harness = ""): ResponseDTO[] {
    const rows = this.sqlite.query(`SELECT r.*,s.display_name,s.title,s.cwd,s.host,s.harness,s.session_id FROM responses r
      JOIN sessions s ON s.key=r.session_key WHERE (? IS NULL OR r.ts<?)
      AND (?=1 OR s.interactive=1)
      AND (?='' OR s.host=?) AND (?='' OR s.harness=?)
      ORDER BY r.ts DESC,r.id DESC LIMIT ?`).all(value(before), value(before), headless ? 1 : 0,
        host, host, harness, harness, Math.min(Math.max(1,limit),500)) as Row[];
    return rows.map((r) => { const dto = this.response(r); dto.displayName ||= s(r.title) || (s(r.cwd) ? basename(String(r.cwd)) : dto.sessionId); return dto; });
  }
  markSeen(key: string): SessionDTO | null {
    this.sqlite.query("UPDATE responses SET seen=1 WHERE session_key=?").run(key);
    return this.getSession(key);
  }
  markAllSeen(): void { this.sqlite.query("UPDATE responses SET seen=1 WHERE seen=0").run(); }
  hasResponses(host: string, harness: Harness, sessionId: string): boolean {
    return !!this.sqlite.query("SELECT 1 FROM responses WHERE session_key=? LIMIT 1").get(`${host}|${harness}|${sessionId}`);
  }
  isConfirmedMissingSession(key: string): boolean {
    return !!this.sqlite.query("SELECT 1 FROM sessions WHERE key=? AND alive=0 AND dead_since IS NOT NULL").get(key);
  }
  addBackfill(session: BackfillSession): SessionDTO {
    const key = sessionKey(session);
    const ts = session.responses.at(-1)?.ts ?? Date.now();
    this.sqlite.transaction(() => {
      this.ensure({ ...session, ts });
      this.sqlite.query(`UPDATE sessions SET cwd=COALESCE(?,cwd),title=COALESCE(?,title),transcript_path=COALESCE(?,transcript_path),
        interactive=MAX(interactive,?),last_activity=MAX(last_activity,?) WHERE key=?`).run(
        value(session.cwd), value(session.title), value(session.transcriptPath), session.interactive ? 1 : 0, ts, key);
      for (const response of session.responses) {
        this.insertResponse(key, clip(response.text)!, describePrompt(response.prompt), response.ts, "backfill", null);
      }
    })();
    return this.getSession(key)!;
  }
  markLiveness(harness: Harness, observed: LivenessRecord[], host: string, now = Date.now(), pidAlive: (pid: number) => boolean = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }, missingPidDead = false): SessionDTO[] {
    const changed: SessionDTO[] = [];
    const seen = new Set<string>();
    for (const record of observed) {
      if (!record.sessionId) continue;
      const key = `${host}|${harness}|${record.sessionId}`;
      seen.add(key);
      const row = this.ensure({ host, harness, sessionId: record.sessionId, ts: now, cwd: record.cwd, title: undefined, interactive: true, transcriptPath: undefined, sessionKind: undefined });
      const state: SessionState = {
        status: row.status as Status, needsReason: s(row.needs_reason), needsText: s(row.needs_text),
        lastActivity: n(row.last_activity),
      };
      const next = harness === "claude" ? reduceLiveness(state, record.detail, now, row.last_hook_event_ts == null ? undefined : n(row.last_hook_event_ts)) : state;
      this.sqlite.query(`UPDATE sessions SET alive=1,pid=?,display_name=COALESCE(?,display_name),cwd=COALESCE(?,cwd),
        status=?,needs_reason=?,needs_text=?,dead_since=NULL,last_liveness_status=COALESCE(?,last_liveness_status) WHERE key=?`)
        .run(value(record.pid), value(record.name), value(record.cwd), next.status, value(next.needsReason), value(next.needsText), value(record.detail), key);
      if (record.detail && record.detail !== row.last_liveness_status) {
        this.sqlite.query("INSERT INTO events(session_key,ts,kind,detail) VALUES(?,?,'liveness',?)").run(key, now, record.detail);
      }
      changed.push(this.getSession(key)!);
    }
    const prior = this.sqlite.query("SELECT key,pid FROM sessions WHERE host=? AND harness=? AND alive=1 AND status!='ended'").all(host,harness) as Row[];
    for (const row of prior) {
      const key = String(row.key);
      if (seen.has(key)) continue;
      const pid = row.pid == null ? undefined : n(row.pid);
      if (pid && pidAlive(pid)) continue;
      this.sqlite.query("UPDATE sessions SET alive=0,dead_since=COALESCE(dead_since,?) WHERE key=?").run(now, key);
      changed.push(this.getSession(key)!);
    }
    if (harness === "claude") changed.push(...this.sweepDeadClaude(host, now, pidAlive, missingPidDead));
    return changed;
  }
  sweepDeadClaude(host: string, now = Date.now(), pidAlive: (pid: number) => boolean = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }, missingPidDead = false): SessionDTO[] {
    const changed: SessionDTO[] = [];
    const stale = this.sqlite.query("SELECT key,pid,last_activity,dead_since FROM sessions WHERE host=? AND harness='claude' AND alive=0 AND status!='ended'").all(host) as Row[];
    for (const row of stale) {
      const key = String(row.key);
      const dead = row.pid == null ? missingPidDead : !pidAlive(n(row.pid));
      const since = row.dead_since == null && dead ? now : n(row.dead_since);
      if (dead && row.dead_since == null) this.sqlite.query("UPDATE sessions SET dead_since=? WHERE key=?").run(now, key);
      if (n(row.last_activity) <= now - 600_000 || (dead && since <= now - 120_000)) {
        this.sqlite.query("UPDATE sessions SET status='ended',needs_reason=NULL,needs_text=NULL WHERE key=?").run(key);
        changed.push(this.getSession(key)!);
      }
    }
    return changed;
  }
}

import type { Database } from "bun:sqlite";
import type { DashDB } from "./db.ts";
import type { AutopilotAction, AutopilotTemplate, AutopilotVerdict, RecentAction } from "./autopilot-policy.ts";
import { redact } from "./redact.ts";

export const AUTOPILOT_DELAY_CHOICES = [0, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120] as const;
export const AUTOPILOT_DEFAULT_MAX_TURNS = 20;
export const AUTOPILOT_DEFAULT_TTL_MS = 8 * 60 * 60_000;
export const AUTOPILOT_MAX_TTL_MS = 24 * 60 * 60_000;
export const AUTOPILOT_RETENTION_MS = 90 * 24 * 60 * 60_000;

export type AutopilotGoalStatus = "active" | "paused" | "escalated" | "done" | "stopped";
export type AutopilotPauseSource = "owner" | "switch" | null;
export type AutopilotDecisionStatus =
  | "sent" | "pending" | "cancelled_owner" | "overridden" | "held" | "stale" | "escalated" | "deferred" | "dropped";
export type AutopilotTemplateType = AutopilotTemplate | "suggestion" | null;
export type AutopilotExecutionMethod = "none" | "immediate" | "timer" | "suggestion" | "deferred" | "owner";
export type StoredAutopilotVerdict = {
  action: AutopilotAction;
  option_indices?: number[];
  reply_text?: string;
  rationale: string;
  confidence: number;
  risk_flags: string[];
};

export interface AutopilotGoal {
  id: number;
  sessionKey: string;
  goalVersionId: number;
  goalText: string;
  stopCondition: string;
  delayMin: number | null;
  status: AutopilotGoalStatus;
  maxTurns: number;
  turnsUsed: number;
  expiresAt: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastVerdict: StoredAutopilotVerdict | null;
  lastVerdictAt: number | null;
  pausedBy: AutopilotPauseSource;
  turnSeqAtResume: number;
  policyRevision?: number;
}

export interface AutopilotGoalVersion {
  id: number;
  goalId: number;
  text: string;
  createdAt: number;
  createdBy: string;
}

export interface AutopilotDecision {
  id: number;
  sessionKey: string;
  project: string;
  goalId: number;
  turnSeq: number;
  responseId: number | null;
  responseHash: string | null;
  decisionSetHash: string | null;
  goalVersionId: number;
  goalPolicyRevision?: number;
  templateType: AutopilotTemplateType;
  verdict: StoredAutopilotVerdict;
  gateRule: string | null;
  delayMin: number | null;
  decidedAt: number;
  deadlineAt: number | null;
  status: AutopilotDecisionStatus;
  executionMethod: AutopilotExecutionMethod;
  replyId: number | null;
  replySuggestion: string | null;
  reviewedAt: number | null;
}

export interface CreateAutopilotGoalInput {
  sessionKey: string;
  goalText: string;
  stopCondition?: string | null;
  delayMin?: number | null;
  maxTurns?: number;
  expiresAt?: number;
  createdBy?: string;
}

export interface UpdateAutopilotGoalInput {
  goalText?: string;
  stopCondition?: string | null;
  delayMin?: number | null;
  maxTurns?: number;
  expiresAt?: number;
}

export interface RecordAutopilotDecisionInput {
  sessionKey: string;
  project: string;
  goalId: number;
  turnSeq: number;
  responseId: number | null;
  responseHash: string | null;
  decisionSetHash: string | null;
  goalVersionId: number;
  goalPolicyRevision?: number;
  templateType: AutopilotTemplateType;
  verdict: AutopilotVerdict;
  gateRule?: string | null;
  delayMin: number | null;
  decidedAt: number;
  deadlineAt?: number | null;
  status: AutopilotDecisionStatus;
  executionMethod: AutopilotExecutionMethod;
  replySuggestion?: string | null;
};

export interface SwitchResult {
  enabled: boolean;
  pausedGoalIds: number[];
  resumedGoalIds: number[];
  affectedSessionKeys: string[];
}

export class AutopilotStoreError extends Error {
  constructor(readonly code: "invalid_input" | "missing_session" | "session_ended" | "goal_exists" | "goal_not_found" | "goal_final") {
    super(code);
    this.name = "AutopilotStoreError";
  }
}

type Row = Record<string, unknown>;
const num = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
};
const nullableNum = (value: unknown): number | null => value == null ? null : num(value);
const text = (value: unknown): string => typeof value === "string" ? value : String(value ?? "");
const nullableText = (value: unknown): string | null => value == null ? null : text(value);
const isSafeTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const isDelay = (value: unknown): value is number => typeof value === "number" && AUTOPILOT_DELAY_CHOICES.includes(value as typeof AUTOPILOT_DELAY_CHOICES[number]);
const validDelay = (value: number | null): boolean => value === null || isDelay(value);
const hasCodePoints = (value: string, min: number, max: number): boolean => {
  const length = Array.from(value).length;
  return length >= min && length <= max;
};
const clip = (value: string, max: number): string => Array.from(value).slice(0, max).join("");
const redacted = (value: string, max: number): string => clip(redact(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim(), max);
const validStatuses = new Set<AutopilotGoalStatus>(["active", "paused", "escalated", "done", "stopped"]);
const validDecisionStatuses = new Set<AutopilotDecisionStatus>([
  "sent", "pending", "cancelled_owner", "overridden", "held", "stale", "escalated", "deferred", "dropped",
]);
const validTemplates = new Set<AutopilotTemplateType>(["T_CONTINUE", "T_CHOOSE_SINGLE", "T_CHOOSE_MULTI", "suggestion", null]);
const validMethods = new Set<AutopilotExecutionMethod>(["none", "immediate", "timer", "suggestion", "deferred", "owner"]);
const validActions = new Set<AutopilotAction>(["continue", "choose_option", "reply", "escalate", "done"]);
const validResponseHash = (value: string | null): boolean => value === null || /^[a-f0-9]{40}$/i.test(value);
const validDecisionHash = (value: string | null): boolean => value === null || /^[a-f0-9]{64}$/i.test(value);
const goalActorId = (actor: string): number | null => {
  const match = /^autopilot:goal:([1-9]\d*)$/.exec(actor);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

function sanitizeVerdict(verdict: AutopilotVerdict): StoredAutopilotVerdict {
  if (!verdict || !validActions.has(verdict.action) || typeof verdict.rationale !== "string" ||
      !Number.isFinite(verdict.confidence) || !Array.isArray(verdict.risk_flags) ||
      verdict.risk_flags.some(flag => typeof flag !== "string") ||
      verdict.option_indices !== undefined && (!Array.isArray(verdict.option_indices) || verdict.option_indices.some(index => !Number.isSafeInteger(index)))) {
    throw new AutopilotStoreError("invalid_input");
  }
  const stored: StoredAutopilotVerdict = {
    action: verdict.action,
    rationale: redacted(verdict.rationale, 600),
    confidence: Math.min(1, Math.max(0, verdict.confidence)),
    risk_flags: verdict.risk_flags.slice(0, 8).map(flag => redacted(flag, 80)),
  };
  if (verdict.option_indices !== undefined) stored.option_indices = verdict.option_indices.slice(0, 8);
  if (typeof verdict.reply_text === "string") stored.reply_text = redacted(verdict.reply_text, 2_000);
  return stored;
}

function parseStoredVerdict(value: unknown): StoredAutopilotVerdict | null {
  if (typeof value !== "string") return null;
  try {
    const candidate = JSON.parse(value) as AutopilotVerdict;
    return sanitizeVerdict(candidate);
  } catch { return null; }
}

function parseDelay(value: unknown): number | null {
  if (value === "never") return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return isDelay(number) ? number : null;
}

export class AutopilotStore {
  readonly sqlite: Database;

  constructor(db: DashDB) {
    this.sqlite = db.sqlite;
    this.installSchema();
    this.reconcileTurnAccounting();
  }

  private installSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS autopilot_goal_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id INTEGER REFERENCES autopilot_goals(id) ON DELETE CASCADE,
        goal_text TEXT NOT NULL CHECK(length(goal_text)<=500),
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL CHECK(length(created_by)<=128),
        UNIQUE(goal_id,goal_text)
      );
      CREATE TABLE IF NOT EXISTS autopilot_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
        goal_version_id INTEGER NOT NULL REFERENCES autopilot_goal_versions(id),
        stop_condition TEXT NOT NULL DEFAULT 'the goal is met' CHECK(length(stop_condition)<=500),
        delay_min INTEGER CHECK(delay_min IS NULL OR delay_min IN (0,1,2,5,10,15,20,30,45,60,90,120)),
        status TEXT NOT NULL CHECK(status IN ('active','paused','escalated','done','stopped')),
        max_turns INTEGER NOT NULL DEFAULT 20 CHECK(max_turns BETWEEN 1 AND 20),
        turns_used INTEGER NOT NULL DEFAULT 0 CHECK(turns_used>=0),
        expires_at INTEGER NOT NULL,
        created_by TEXT NOT NULL CHECK(length(created_by)<=128),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_verdict_json TEXT,
        last_verdict_at INTEGER,
        paused_by TEXT CHECK(paused_by IS NULL OR paused_by IN ('owner','switch')),
        turn_seq_at_resume INTEGER NOT NULL DEFAULT 0 CHECK(turn_seq_at_resume>=0),
        policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(policy_revision>=0)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS autopilot_one_open_goal_per_session
        ON autopilot_goals(session_key) WHERE status IN ('active','paused');
      CREATE INDEX IF NOT EXISTS autopilot_goals_status_expiry ON autopilot_goals(status,expires_at,id);
      CREATE INDEX IF NOT EXISTS autopilot_goal_versions_goal ON autopilot_goal_versions(goal_id,id);
      CREATE TRIGGER IF NOT EXISTS autopilot_goal_version_owner
      BEFORE UPDATE OF goal_version_id ON autopilot_goals
      WHEN NOT EXISTS (SELECT 1 FROM autopilot_goal_versions v WHERE v.id=NEW.goal_version_id AND v.goal_id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'goal version must belong to goal'); END;

      CREATE TABLE IF NOT EXISTS autopilot_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
        project TEXT NOT NULL CHECK(length(project)<=200),
        goal_id INTEGER NOT NULL REFERENCES autopilot_goals(id),
        turn_seq INTEGER NOT NULL CHECK(turn_seq>=0),
        response_id INTEGER,
        response_hash TEXT CHECK(response_hash IS NULL OR length(response_hash) IN (40,64)),
        decision_set_hash TEXT CHECK(decision_set_hash IS NULL OR length(decision_set_hash)=64),
        goal_version_id INTEGER NOT NULL REFERENCES autopilot_goal_versions(id),
        goal_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(goal_policy_revision>=0),
        template_type TEXT CHECK(template_type IS NULL OR template_type IN ('T_CONTINUE','T_CHOOSE_SINGLE','T_CHOOSE_MULTI','suggestion')),
        verdict_json TEXT NOT NULL CHECK(length(verdict_json)<=12_000),
        gate_rule TEXT CHECK(gate_rule IS NULL OR length(gate_rule)<=120),
        delay_min INTEGER CHECK(delay_min IS NULL OR delay_min IN (0,1,2,5,10,15,20,30,45,60,90,120)),
        decided_at INTEGER NOT NULL,
        deadline_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('sent','pending','cancelled_owner','overridden','held','stale','escalated','deferred','dropped')),
        execution_method TEXT NOT NULL CHECK(execution_method IN ('none','immediate','timer','suggestion','deferred','owner')),
        reply_id INTEGER,
        reply_suggestion TEXT CHECK(reply_suggestion IS NULL OR length(reply_suggestion)<=2000),
        reviewed_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS autopilot_one_pending_action_per_session
        ON autopilot_decisions(session_key) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS autopilot_decisions_session_time ON autopilot_decisions(session_key,decided_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS autopilot_decisions_goal_time ON autopilot_decisions(goal_id,decided_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS autopilot_decisions_expiry ON autopilot_decisions(decided_at,id);
      CREATE INDEX IF NOT EXISTS autopilot_decisions_rate ON autopilot_decisions(status,template_type,decided_at);

      CREATE TABLE IF NOT EXISTS autopilot_turn_events (
        event_key TEXT PRIMARY KEY,
        goal_id INTEGER NOT NULL,
        event_kind TEXT NOT NULL CHECK(event_kind IN ('reply','dialog')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS autopilot_turn_events_goal ON autopilot_turn_events(goal_id,created_at);

      CREATE TRIGGER IF NOT EXISTS autopilot_count_reply_commit
      AFTER UPDATE OF committed_at ON replies
      WHEN OLD.committed_at IS NULL AND NEW.committed_at IS NOT NULL AND NEW.source='autopilot'
        AND NEW.actor GLOB 'autopilot:goal:[1-9]*'
        AND substr(NEW.actor,16) NOT GLOB '*[^0-9]*'
        AND CAST(substr(NEW.actor,16) AS INTEGER)>0
        AND EXISTS (
          SELECT 1 FROM reply_audit a JOIN autopilot_goals g ON g.id=a.goal_id AND g.session_key=a.session_key
          WHERE a.reply_id=NEW.id AND a.session_key=NEW.session_key AND a.source='autopilot'
            AND a.actor=NEW.actor AND a.goal_id=CAST(substr(NEW.actor,16) AS INTEGER)
        )
      BEGIN
        INSERT OR IGNORE INTO autopilot_turn_events(event_key,goal_id,event_kind,created_at)
        SELECT 'reply:'||NEW.id,a.goal_id,'reply',NEW.committed_at FROM reply_audit a
        WHERE a.reply_id=NEW.id AND a.session_key=NEW.session_key AND a.source='autopilot'
          AND a.actor=NEW.actor AND a.goal_id=CAST(substr(NEW.actor,16) AS INTEGER);
      END;

      CREATE TRIGGER IF NOT EXISTS autopilot_count_dialog_consumed
      AFTER UPDATE OF state ON question_invocations
      WHEN OLD.state='answered' AND NEW.state='consumed' AND NEW.source='autopilot'
        AND NEW.actor GLOB 'autopilot:goal:[1-9]*'
        AND substr(NEW.actor,16) NOT GLOB '*[^0-9]*'
        AND CAST(substr(NEW.actor,16) AS INTEGER)>0
        AND NEW.answered_at IS NOT NULL AND NEW.done_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM reply_audit a JOIN autopilot_goals g ON g.id=a.goal_id AND g.session_key=a.session_key
          WHERE a.reply_id IS NULL AND a.session_key=NEW.session_key AND a.source='autopilot'
            AND a.actor=NEW.actor AND a.goal_id=CAST(substr(NEW.actor,16) AS INTEGER) AND a.ts=NEW.answered_at
        )
      BEGIN
        INSERT OR IGNORE INTO autopilot_turn_events(event_key,goal_id,event_kind,created_at)
        SELECT 'question:'||NEW.question_id,a.goal_id,'dialog',NEW.done_at FROM reply_audit a
        WHERE a.reply_id IS NULL AND a.session_key=NEW.session_key AND a.source='autopilot'
          AND a.actor=NEW.actor AND a.goal_id=CAST(substr(NEW.actor,16) AS INTEGER) AND a.ts=NEW.answered_at;
      END;

      CREATE TRIGGER IF NOT EXISTS autopilot_apply_turn_event
      AFTER INSERT ON autopilot_turn_events
      BEGIN
        UPDATE autopilot_goals SET turns_used=turns_used+1,updated_at=MAX(updated_at,NEW.created_at)
        WHERE id=NEW.goal_id;
      END;
    `);
    const goalColumns = new Set((this.sqlite.query("PRAGMA table_info(autopilot_goals)").all() as Row[]).map(row => text(row.name)));
    if (!goalColumns.has("policy_revision"))
      this.sqlite.exec("ALTER TABLE autopilot_goals ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(policy_revision>=0)");
    const decisionColumns = new Set((this.sqlite.query("PRAGMA table_info(autopilot_decisions)").all() as Row[]).map(row => text(row.name)));
    if (!decisionColumns.has("goal_policy_revision"))
      this.sqlite.exec("ALTER TABLE autopilot_decisions ADD COLUMN goal_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(goal_policy_revision>=0)");
    this.sqlite.query("INSERT OR IGNORE INTO settings(k,v) VALUES('autopilot.enabled','0')").run();
    this.sqlite.query("INSERT OR IGNORE INTO settings(k,v) VALUES('autopilot.away','0')").run();
    this.sqlite.query("INSERT OR IGNORE INTO settings(k,v) VALUES('autopilot.delay_min','0')").run();
    this.sqlite.query("INSERT OR IGNORE INTO settings(k,v) VALUES('autopilot.stop_phrases','[]')").run();

    // An immediate submission interrupted between journaling and replies.submit is never replayed after restart.
    this.sqlite.query(`UPDATE autopilot_decisions SET status='stale',gate_rule='interrupted_immediate'
      WHERE status='pending' AND execution_method='immediate'`).run();
  }

  /** Replays source transitions idempotently before a controller can resume work. */
  reconcileTurnAccounting(): number {
    return this.sqlite.transaction(() => this.sqlite.query(`
      INSERT OR IGNORE INTO autopilot_turn_events(event_key,goal_id,event_kind,created_at)
      SELECT 'reply:'||r.id,a.goal_id,'reply',r.committed_at
      FROM replies r JOIN reply_audit a ON a.reply_id=r.id
      JOIN autopilot_goals g ON g.id=a.goal_id AND g.session_key=a.session_key
      WHERE r.source='autopilot' AND r.committed_at IS NOT NULL AND a.source='autopilot'
        AND a.session_key=r.session_key AND a.actor=r.actor
        AND r.actor GLOB 'autopilot:goal:[1-9]*' AND substr(r.actor,16) NOT GLOB '*[^0-9]*'
        AND a.goal_id=CAST(substr(r.actor,16) AS INTEGER)
      UNION ALL
      SELECT 'question:'||q.question_id,a.goal_id,'dialog',q.done_at
      FROM question_invocations q JOIN reply_audit a ON a.reply_id IS NULL AND a.session_key=q.session_key
        AND a.source=q.source AND a.actor=q.actor AND a.ts=q.answered_at
      JOIN autopilot_goals g ON g.id=a.goal_id AND g.session_key=a.session_key
      WHERE q.state='consumed' AND q.source='autopilot' AND q.actor GLOB 'autopilot:goal:[1-9]*'
        AND substr(q.actor,16) NOT GLOB '*[^0-9]*' AND a.goal_id=CAST(substr(q.actor,16) AS INTEGER)
        AND q.answered_at IS NOT NULL AND q.done_at IS NOT NULL
    `).run().changes)();
  }

  private setting(key: string): string | undefined {
    const row = this.sqlite.query("SELECT v FROM settings WHERE k=?").get(key) as { v: string } | null;
    return row?.v;
  }
  private setSetting(key: string, value: string): void {
    this.sqlite.query("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(key,value);
  }

  masterEnabled(): boolean { return this.setting("autopilot.enabled") === "1"; }
  setMasterEnabled(enabled: boolean, now = Date.now()): SwitchResult {
    if (typeof enabled !== "boolean" || !isSafeTime(now)) throw new AutopilotStoreError("invalid_input");
    return this.sqlite.transaction(() => {
      const wasEnabled = this.masterEnabled();
      this.setSetting("autopilot.enabled",enabled ? "1" : "0");
      let pausedGoalIds: number[] = [], resumedGoalIds: number[] = [];
      if (!enabled) {
        pausedGoalIds = (this.sqlite.query("SELECT id FROM autopilot_goals WHERE status='active' ORDER BY id").all() as Row[]).map(row => num(row.id));
        this.sqlite.query(`UPDATE autopilot_goals SET status='paused',paused_by='switch',updated_at=?
          WHERE status='active'`).run(now);
      } else {
        resumedGoalIds = (this.sqlite.query("SELECT id FROM autopilot_goals WHERE status='paused' AND paused_by='switch' ORDER BY id").all() as Row[]).map(row => num(row.id));
        this.sqlite.query(`UPDATE autopilot_goals SET status='active',paused_by=NULL,
          turn_seq_at_resume=COALESCE((SELECT s.turn_seq FROM sessions s WHERE s.key=autopilot_goals.session_key),turn_seq_at_resume),updated_at=?
          WHERE status='paused' AND paused_by='switch'`).run(now);
      }
      const affected = new Set<string>();
      for (const row of this.sqlite.query(`SELECT DISTINCT session_key FROM autopilot_goals
        WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...pausedGoalIds,...resumedGoalIds])) as Row[]) affected.add(text(row.session_key));
      if (!enabled) {
        const pending = this.sqlite.query("SELECT DISTINCT session_key FROM autopilot_decisions WHERE status='pending'").all() as Row[];
        for (const row of pending) affected.add(text(row.session_key));
        this.sqlite.query(`UPDATE autopilot_decisions SET status='cancelled_owner',gate_rule='switch_off'
          WHERE status='pending'`).run();
      }
      return { enabled, pausedGoalIds, resumedGoalIds, affectedSessionKeys: [...affected] };
    })();
  }

  away(): boolean { return this.setting("autopilot.away") === "1"; }
  setAway(away: boolean): void {
    if (typeof away !== "boolean") throw new AutopilotStoreError("invalid_input");
    this.setSetting("autopilot.away",away ? "1" : "0");
  }

  defaultDelayMin(): number | null { return parseDelay(this.setting("autopilot.delay_min")); }
  setDefaultDelayMin(delayMin: number | null): void {
    if (!validDelay(delayMin)) throw new AutopilotStoreError("invalid_input");
    this.setSetting("autopilot.delay_min",delayMin === null ? "never" : String(delayMin));
  }

  customStopPhrases(): string[] {
    let raw: unknown;
    try { raw = JSON.parse(this.setting("autopilot.stop_phrases") ?? "[]"); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    return raw.filter((phrase): phrase is string => typeof phrase === "string" && hasCodePoints(phrase,1,120)).slice(0,64);
  }
  setCustomStopPhrases(phrases: readonly string[]): void {
    if (!Array.isArray(phrases) || phrases.length > 64 || phrases.some(phrase => typeof phrase !== "string" || !hasCodePoints(phrase,1,120)))
      throw new AutopilotStoreError("invalid_input");
    this.setSetting("autopilot.stop_phrases",JSON.stringify([...phrases]));
  }

  private validateGoalInput(input: CreateAutopilotGoalInput, now: number): {
    goalText: string; stopCondition: string; delayMin: number | null; maxTurns: number; expiresAt: number; createdBy: string;
  } {
    const goalText = input.goalText;
    const stopCondition = input.stopCondition == null ? "the goal is met" : input.stopCondition;
    const delayMin = input.delayMin === undefined ? this.defaultDelayMin() : input.delayMin;
    const maxTurns = input.maxTurns ?? AUTOPILOT_DEFAULT_MAX_TURNS;
    const expiresAt = input.expiresAt ?? now + AUTOPILOT_DEFAULT_TTL_MS;
    const createdBy = input.createdBy ?? "owner";
    if (typeof input.sessionKey !== "string" || !input.sessionKey || typeof goalText !== "string" || !hasCodePoints(goalText,1,500) ||
        typeof stopCondition !== "string" || !hasCodePoints(stopCondition,1,500) || !validDelay(delayMin) ||
        !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 20 || !isSafeTime(expiresAt) ||
        expiresAt <= now || expiresAt - now > AUTOPILOT_MAX_TTL_MS ||
        typeof createdBy !== "string" || !hasCodePoints(createdBy,1,128) || !isSafeTime(now)) throw new AutopilotStoreError("invalid_input");
    return { goalText,stopCondition,delayMin,maxTurns,expiresAt,createdBy };
  }

  createGoal(input: CreateAutopilotGoalInput, now = Date.now()): AutopilotGoal {
    const values = this.validateGoalInput(input,now);
    return this.sqlite.transaction(() => {
      const session = this.sqlite.query("SELECT status FROM sessions WHERE key=?").get(input.sessionKey) as { status: string } | null;
      if (!session) throw new AutopilotStoreError("missing_session");
      if (session.status === "ended") throw new AutopilotStoreError("session_ended");
      if (this.sqlite.query("SELECT 1 FROM autopilot_goals WHERE session_key=? AND status IN ('active','paused')").get(input.sessionKey))
        throw new AutopilotStoreError("goal_exists");
      const versionId = Number(this.sqlite.query(`INSERT INTO autopilot_goal_versions(goal_text,created_at,created_by)
        VALUES(?,?,?)`).run(values.goalText,now,values.createdBy).lastInsertRowid);
      const goalId = Number(this.sqlite.query(`INSERT INTO autopilot_goals
        (session_key,goal_version_id,stop_condition,delay_min,status,max_turns,turns_used,expires_at,created_by,created_at,updated_at,turn_seq_at_resume)
        VALUES(?,?,?,?, 'active',?,0,?,?,?,?,COALESCE((SELECT turn_seq FROM sessions WHERE key=?),0))`)
        .run(input.sessionKey,versionId,values.stopCondition,values.delayMin,values.maxTurns,values.expiresAt,values.createdBy,now,now,input.sessionKey).lastInsertRowid);
      this.sqlite.query("UPDATE autopilot_goal_versions SET goal_id=? WHERE id=? AND goal_id IS NULL").run(goalId,versionId);
      return this.getGoal(goalId)!;
    })();
  }

  private goalRow(id: number): Row | null {
    return this.sqlite.query(`SELECT g.*,v.goal_text FROM autopilot_goals g
      JOIN autopilot_goal_versions v ON v.id=g.goal_version_id WHERE g.id=?`).get(id) as Row | null;
  }
  private goal(row: Row | null): AutopilotGoal | undefined {
    if (!row) return undefined;
    const status = text(row.status) as AutopilotGoalStatus;
    const storedDelay = row.delay_min == null ? null : num(row.delay_min,-1);
    const delayMin = storedDelay === null || isDelay(storedDelay) ? storedDelay : null;
    return {
      id:num(row.id),sessionKey:text(row.session_key),goalVersionId:num(row.goal_version_id),goalText:text(row.goal_text),
      stopCondition:text(row.stop_condition),delayMin,status:validStatuses.has(status) ? status : "stopped",
      maxTurns:num(row.max_turns,AUTOPILOT_DEFAULT_MAX_TURNS),turnsUsed:num(row.turns_used),expiresAt:num(row.expires_at),
      createdBy:text(row.created_by),createdAt:num(row.created_at),updatedAt:num(row.updated_at),
      lastVerdict:parseStoredVerdict(row.last_verdict_json),lastVerdictAt:nullableNum(row.last_verdict_at),
      pausedBy:row.paused_by === "owner" || row.paused_by === "switch" ? row.paused_by : null,
      turnSeqAtResume:num(row.turn_seq_at_resume),policyRevision:num(row.policy_revision),
    };
  }
  getGoal(id: number): AutopilotGoal | undefined { return this.goal(this.goalRow(id)); }
  goalForSession(sessionKey: string): AutopilotGoal | undefined {
    const row = this.sqlite.query(`SELECT g.*,v.goal_text FROM autopilot_goals g
      JOIN autopilot_goal_versions v ON v.id=g.goal_version_id
      WHERE g.session_key=? AND g.status IN ('active','paused','escalated')
      ORDER BY CASE WHEN g.status IN ('active','paused') THEN 0 ELSE 1 END,g.id DESC LIMIT 1`).get(sessionKey) as Row | null;
    return this.goal(row);
  }
  listGoals(status: AutopilotGoalStatus | "all" = "all", limit = 200): AutopilotGoal[] {
    if (status !== "all" && !validStatuses.has(status)) throw new AutopilotStoreError("invalid_input");
    const bounded = Math.min(500,Math.max(1,Math.floor(Number.isFinite(limit) ? limit : 200)));
    const rows = (status === "all"
      ? this.sqlite.query(`SELECT g.*,v.goal_text FROM autopilot_goals g JOIN autopilot_goal_versions v ON v.id=g.goal_version_id
        ORDER BY g.updated_at DESC,g.id DESC LIMIT ?`).all(bounded)
      : this.sqlite.query(`SELECT g.*,v.goal_text FROM autopilot_goals g JOIN autopilot_goal_versions v ON v.id=g.goal_version_id
        WHERE g.status=? ORDER BY g.updated_at DESC,g.id DESC LIMIT ?`).all(status,bounded)) as Row[];
    return rows.map(row => this.goal(row)!);
  }
  goalVersions(goalId: number): AutopilotGoalVersion[] {
    return (this.sqlite.query(`SELECT id,goal_id,goal_text,created_at,created_by FROM autopilot_goal_versions
      WHERE goal_id=? ORDER BY id`).all(goalId) as Row[]).map(row => ({
      id:num(row.id),goalId:num(row.goal_id),text:text(row.goal_text),createdAt:num(row.created_at),createdBy:text(row.created_by),
    }));
  }

  updateGoal(id: number, patch: UpdateAutopilotGoalInput, now = Date.now()): AutopilotGoal {
    if (!Number.isSafeInteger(id) || id < 1 || !isSafeTime(now)) throw new AutopilotStoreError("invalid_input");
    return this.sqlite.transaction(() => {
      const current = this.getGoal(id);
      if (!current) throw new AutopilotStoreError("goal_not_found");
      if (current.status === "done" || current.status === "stopped" || current.status === "escalated") throw new AutopilotStoreError("goal_final");
      const goalText = patch.goalText ?? current.goalText;
      const stopCondition = patch.stopCondition === undefined ? current.stopCondition : patch.stopCondition ?? "the goal is met";
      const delayMin = patch.delayMin === undefined ? current.delayMin : patch.delayMin;
      const maxTurns = patch.maxTurns ?? current.maxTurns;
      const expiresAt = patch.expiresAt ?? current.expiresAt;
      if (typeof goalText !== "string" || !hasCodePoints(goalText,1,500) || typeof stopCondition !== "string" || !hasCodePoints(stopCondition,1,500) ||
          !validDelay(delayMin) || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 20 || !isSafeTime(expiresAt) ||
          expiresAt - now > AUTOPILOT_MAX_TTL_MS || (patch.expiresAt !== undefined && expiresAt <= now))
        throw new AutopilotStoreError("invalid_input");
      let versionId = current.goalVersionId;
      if (goalText !== current.goalText) {
        const existing = this.sqlite.query("SELECT id FROM autopilot_goal_versions WHERE goal_id=? AND goal_text=? ORDER BY id LIMIT 1")
          .get(id,goalText) as { id: number } | null;
        versionId = existing ? num(existing.id) : Number(this.sqlite.query(`INSERT INTO autopilot_goal_versions(goal_id,goal_text,created_at,created_by)
          VALUES(?,?,?,?)`).run(id,goalText,now,current.createdBy).lastInsertRowid);
      }
      const policyChanged = goalText !== current.goalText || stopCondition !== current.stopCondition ||
        maxTurns !== current.maxTurns || expiresAt !== current.expiresAt;
      this.sqlite.query(`UPDATE autopilot_goals SET goal_version_id=?,stop_condition=?,delay_min=?,max_turns=?,expires_at=?,
        policy_revision=policy_revision+?,updated_at=? WHERE id=?`)
        .run(versionId,stopCondition,delayMin,maxTurns,expiresAt,policyChanged ? 1 : 0,now,id);
      if (delayMin !== current.delayMin) {
        this.sqlite.query(`UPDATE autopilot_decisions SET delay_min=?,deadline_at=CASE WHEN ? IS NULL THEN NULL ELSE decided_at + (? * 60000) END
          WHERE goal_id=? AND status='pending' AND template_type IS NOT NULL`)
          .run(delayMin,delayMin,delayMin,id);
      }
      return this.getGoal(id)!;
    })();
  }

  pauseGoal(id: number, by: "owner" = "owner", now = Date.now()): boolean {
    if (by !== "owner" || !Number.isSafeInteger(id) || id < 1 || !isSafeTime(now)) throw new AutopilotStoreError("invalid_input");
    return this.sqlite.query(`UPDATE autopilot_goals SET status='paused',paused_by='owner',updated_at=?
      WHERE id=? AND status='active'`).run(now,id).changes === 1;
  }
  resumeGoal(id: number, turnSeq: number, now = Date.now()): boolean {
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(turnSeq) || turnSeq < 0 || !isSafeTime(now))
      throw new AutopilotStoreError("invalid_input");
    return this.sqlite.query(`UPDATE autopilot_goals SET status='active',paused_by=NULL,turn_seq_at_resume=?,updated_at=?
      WHERE id=? AND status IN ('paused','escalated')`).run(turnSeq,now,id).changes === 1;
  }
  stopGoal(id: number, now = Date.now()): boolean { return this.finishGoal(id,"stopped",now); }
  finishGoal(id: number, status: "done" | "stopped" | "escalated", now = Date.now()): boolean {
    if (!Number.isSafeInteger(id) || id < 1 || !isSafeTime(now)) throw new AutopilotStoreError("invalid_input");
    return this.sqlite.transaction(() => {
      const changed = this.sqlite.query(`UPDATE autopilot_goals SET status=?,paused_by=NULL,updated_at=?
        WHERE id=? AND status IN ('active','paused','escalated')`).run(status,now,id).changes === 1;
      if (changed) this.sqlite.query(`UPDATE autopilot_decisions SET status='held',gate_rule=?
        WHERE goal_id=? AND status='pending'`).run(status,id);
      return changed;
    })();
  }
  markDone(id: number, now = Date.now()): boolean { return this.finishGoal(id,"done",now); }
  escalateGoal(id: number, reason: string, now = Date.now()): boolean {
    if (typeof reason !== "string" || !hasCodePoints(reason,1,120) || !isSafeTime(now))
      throw new AutopilotStoreError("invalid_input");
    const safeReason = redacted(reason,120);
    return this.sqlite.transaction(() => {
      const changed = this.sqlite.query(`UPDATE autopilot_goals SET status='escalated',paused_by=NULL,updated_at=?
        WHERE id=? AND status IN ('active','paused')`).run(now,id).changes === 1;
      if (changed) this.sqlite.query(`UPDATE autopilot_decisions SET status='escalated',gate_rule=?
        WHERE goal_id=? AND status='pending'`).run(safeReason,id);
      return changed;
    })();
  }

  ownerReplyPending(sessionKey: string): boolean {
    return !!this.sqlite.query(`SELECT 1 FROM replies WHERE session_key=? AND source IN ('web','telegram')
      AND state IN ('queued','leased') AND committed_at IS NULL LIMIT 1`).get(sessionKey);
  }
  lastCommittedReplyAt(sessionKey: string, now = Date.now()): number | null {
    const row = this.sqlite.query(`SELECT MAX(e.created_at) AS committed_at FROM autopilot_turn_events e
      JOIN autopilot_goals g ON g.id=e.goal_id
      WHERE g.session_key=? AND e.event_kind IN ('reply','dialog') AND e.created_at<=?`).get(sessionKey,now) as Row;
    return nullableNum(row?.committed_at);
  }
  committedRepliesLastHour(now = Date.now()): number {
    if (!isSafeTime(now)) throw new AutopilotStoreError("invalid_input");
    const row = this.sqlite.query(`SELECT COUNT(*) AS n FROM autopilot_turn_events
      WHERE event_kind IN ('reply','dialog') AND created_at>=? AND created_at<=?`).get(now-60*60_000,now) as Row;
    return num(row?.n);
  }
  recentActions(sessionKey: string, limit = 2): RecentAction[] {
    const bounded = Math.min(20,Math.max(1,Math.floor(Number.isFinite(limit) ? limit : 2)));
    return (this.sqlite.query(`SELECT template_type,response_hash,decision_set_hash,status FROM autopilot_decisions
      WHERE session_key=? AND status='sent' AND template_type IN ('T_CONTINUE','T_CHOOSE_SINGLE','T_CHOOSE_MULTI')
      ORDER BY decided_at DESC,id DESC LIMIT ?`).all(sessionKey,bounded) as Row[]).map(row => ({
        template: text(row.template_type) as AutopilotTemplate,
        responseHash: text(row.response_hash),decisionSetHash:text(row.decision_set_hash),status:text(row.status),
      }));
  }

  private decisionRow(id: number): Row | null {
    return this.sqlite.query("SELECT * FROM autopilot_decisions WHERE id=?").get(id) as Row | null;
  }
  private decision(row: Row | null): AutopilotDecision | undefined {
    if (!row) return undefined;
    let template = nullableText(row.template_type) as AutopilotTemplateType;
    if (!validTemplates.has(template)) template = null;
    const status = text(row.status) as AutopilotDecisionStatus;
    const method = text(row.execution_method) as AutopilotExecutionMethod;
    const verdict = parseStoredVerdict(row.verdict_json) ?? {
      action:"escalate" as const,rationale:"invalid stored verdict",confidence:0,risk_flags:["invalid_verdict"],
    };
    const rawDelay = row.delay_min == null ? null : num(row.delay_min,-1);
    return {
      id:num(row.id),sessionKey:text(row.session_key),project:text(row.project),goalId:num(row.goal_id),turnSeq:num(row.turn_seq),
      responseId:nullableNum(row.response_id),responseHash:nullableText(row.response_hash),decisionSetHash:nullableText(row.decision_set_hash),
      goalVersionId:num(row.goal_version_id),goalPolicyRevision:num(row.goal_policy_revision),templateType:template,verdict,gateRule:nullableText(row.gate_rule),
      delayMin:rawDelay,decidedAt:num(row.decided_at),deadlineAt:nullableNum(row.deadline_at),
      status:validDecisionStatuses.has(status) ? status : "dropped",executionMethod:validMethods.has(method) ? method : "none",
      replyId:nullableNum(row.reply_id),replySuggestion:nullableText(row.reply_suggestion),reviewedAt:nullableNum(row.reviewed_at),
    };
  }
  getDecision(id: number): AutopilotDecision | undefined { return this.decision(this.decisionRow(id)); }
  recordDecision(input: RecordAutopilotDecisionInput): AutopilotDecision {
    const verdict = sanitizeVerdict(input.verdict);
    const deadlineAt = input.deadlineAt ?? null;
    const suggestion = input.replySuggestion == null ? null : redacted(input.replySuggestion,2_000);
    const gateRule = input.gateRule == null ? null : redacted(input.gateRule,120);
    const goalPolicyRevision = input.goalPolicyRevision ?? 0;
    if (!Number.isSafeInteger(goalPolicyRevision) || goalPolicyRevision < 0 ||
        !Number.isSafeInteger(input.goalId) || input.goalId < 1 || !Number.isSafeInteger(input.goalVersionId) || input.goalVersionId < 1 ||
        typeof input.sessionKey !== "string" || !input.sessionKey || typeof input.project !== "string" || !hasCodePoints(input.project,0,200) ||
        !Number.isSafeInteger(input.turnSeq) || input.turnSeq < 0 || input.responseId !== null && (!Number.isSafeInteger(input.responseId) || input.responseId < 1) ||
        !validResponseHash(input.responseHash) || !validDecisionHash(input.decisionSetHash) || !validTemplates.has(input.templateType) ||
        !validDecisionStatuses.has(input.status) || !validMethods.has(input.executionMethod) || !validDelay(input.delayMin) ||
        !isSafeTime(input.decidedAt) || deadlineAt !== null && !isSafeTime(deadlineAt)) throw new AutopilotStoreError("invalid_input");
    return this.sqlite.transaction(() => {
      const matching = this.sqlite.query(`SELECT 1 FROM autopilot_goal_versions WHERE id=? AND goal_id=?`).get(input.goalVersionId,input.goalId);
      const goal = this.sqlite.query("SELECT session_key FROM autopilot_goals WHERE id=?").get(input.goalId) as { session_key: string } | null;
      if (!matching || !goal || goal.session_key !== input.sessionKey) throw new AutopilotStoreError("goal_not_found");
      const id = Number(this.sqlite.query(`INSERT INTO autopilot_decisions
        (session_key,project,goal_id,turn_seq,response_id,response_hash,decision_set_hash,goal_version_id,goal_policy_revision,template_type,verdict_json,
         gate_rule,delay_min,decided_at,deadline_at,status,execution_method,reply_suggestion)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(input.sessionKey,clip(input.project,200),input.goalId,input.turnSeq,input.responseId,input.responseHash,input.decisionSetHash,
          input.goalVersionId,goalPolicyRevision,input.templateType,JSON.stringify(verdict),gateRule,input.delayMin,input.decidedAt,deadlineAt,input.status,
          input.executionMethod,suggestion).lastInsertRowid);
      this.sqlite.query("UPDATE autopilot_goals SET last_verdict_json=?,last_verdict_at=?,updated_at=MAX(updated_at,?) WHERE id=?")
        .run(JSON.stringify(verdict),input.decidedAt,input.decidedAt,input.goalId);
      return this.getDecision(id)!;
    })();
  }
  transitionDecision(id: number, from: readonly AutopilotDecisionStatus[], to: AutopilotDecisionStatus, now: number,
    patch: { gateRule?: string | null; executionMethod?: AutopilotExecutionMethod; replyId?: number | null; deadlineAt?: number | null } = {}): boolean {
    if (!Number.isSafeInteger(id) || id < 1 || !from.length || from.some(status => !validDecisionStatuses.has(status)) ||
        !validDecisionStatuses.has(to) || !isSafeTime(now) || patch.executionMethod !== undefined && !validMethods.has(patch.executionMethod))
      throw new AutopilotStoreError("invalid_input");
    const placeholders = from.map(() => "?").join(",");
    const gateRule = patch.gateRule === undefined ? null : patch.gateRule === null ? null : redacted(patch.gateRule,120);
    const replyId = patch.replyId ?? null;
    const deadlineAt = patch.deadlineAt === undefined ? undefined : patch.deadlineAt;
    if (patch.replyId != null && (!Number.isSafeInteger(patch.replyId) || patch.replyId < 1) ||
        deadlineAt !== undefined && deadlineAt !== null && !isSafeTime(deadlineAt))
      throw new AutopilotStoreError("invalid_input");
    return this.sqlite.query(`UPDATE autopilot_decisions SET status=?,
      gate_rule=CASE WHEN ?=1 THEN ? ELSE gate_rule END,
      execution_method=COALESCE(?,execution_method),
      reply_id=CASE WHEN ?=1 THEN ? ELSE reply_id END,
      deadline_at=CASE WHEN ?=1 THEN ? ELSE deadline_at END
      WHERE id=? AND status IN (${placeholders})`)
      .run(to,patch.gateRule === undefined ? 0 : 1,gateRule,patch.executionMethod ?? null,
        patch.replyId === undefined ? 0 : 1,replyId,deadlineAt === undefined ? 0 : 1,deadlineAt ?? null,id,...from).changes === 1;
  }
  cancelPendingActions(sessionKey: string, status: "cancelled_owner" | "held" | "stale" = "cancelled_owner", reason = "owner", now = Date.now()): number {
    if (typeof sessionKey !== "string" || !sessionKey || !["cancelled_owner","held","stale"].includes(status) ||
        typeof reason !== "string" || !hasCodePoints(reason,1,120) || !isSafeTime(now)) throw new AutopilotStoreError("invalid_input");
    return this.sqlite.query(`UPDATE autopilot_decisions SET status=?,gate_rule=? WHERE session_key=? AND status='pending'`)
      .run(status,redacted(reason,120),sessionKey).changes;
  }
  currentPendingAction(sessionKey: string): AutopilotDecision | undefined {
    const row = this.sqlite.query("SELECT * FROM autopilot_decisions WHERE session_key=? AND status='pending' ORDER BY id DESC LIMIT 1")
      .get(sessionKey) as Row | null;
    return this.decision(row);
  }
  pendingActions(): AutopilotDecision[] {
    return (this.sqlite.query("SELECT * FROM autopilot_decisions WHERE status='pending' ORDER BY COALESCE(deadline_at,9223372036854775807),id")
      .all() as Row[]).map(row => this.decision(row)!);
  }
  duePendingActions(now = Date.now(), limit = 100): AutopilotDecision[] {
    if (!isSafeTime(now)) throw new AutopilotStoreError("invalid_input");
    const bounded = Math.min(500,Math.max(1,Math.floor(Number.isFinite(limit) ? limit : 100)));
    return (this.sqlite.query(`SELECT * FROM autopilot_decisions WHERE status='pending' AND execution_method='timer'
      AND deadline_at IS NOT NULL AND deadline_at<=? ORDER BY deadline_at,id LIMIT ?`).all(now,bounded) as Row[]).map(row => this.decision(row)!);
  }
  listDecisions(options: { sessionKey?: string; project?: string; projects?: readonly string[]; status?: AutopilotDecisionStatus;
    unreviewedOnly?: boolean; limit?: number; offset?: number } = {}): AutopilotDecision[] {
    if (options.status !== undefined && !validDecisionStatuses.has(options.status)) throw new AutopilotStoreError("invalid_input");
    const clauses: string[] = [], args: (string | number)[] = [];
    if (options.sessionKey !== undefined) { clauses.push("session_key=?"); args.push(options.sessionKey); }
    if (options.project !== undefined) { clauses.push("project=?"); args.push(options.project); }
    if (options.projects !== undefined) {
      const projects = [...new Set(options.projects)];
      if (projects.length) { clauses.push(`project IN (${projects.map(() => "?").join(",")})`); args.push(...projects); }
      else clauses.push("0");
    }
    if (options.unreviewedOnly) clauses.push("reviewed_at IS NULL");
    if (options.status !== undefined) { clauses.push("status=?"); args.push(options.status); }
    const limit = Math.min(500,Math.max(1,Math.floor(Number.isFinite(options.limit) ? options.limit! : 100)));
    const offset = Math.max(0,Math.floor(Number.isFinite(options.offset) ? options.offset! : 0));
    return (this.sqlite.query(`SELECT * FROM autopilot_decisions ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY decided_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args,limit,offset) as Row[]).map(row => this.decision(row)!);
  }
  markReviewed(id: number, now = Date.now()): boolean {
    if (!Number.isSafeInteger(id) || id < 1 || !isSafeTime(now)) throw new AutopilotStoreError("invalid_input");
    return this.sqlite.query("UPDATE autopilot_decisions SET reviewed_at=? WHERE id=? AND reviewed_at IS NULL").run(now,id).changes === 1;
  }
  claimSuggestion(id: number, now = Date.now()): boolean {
    if (!Number.isSafeInteger(id) || id < 1 || !isSafeTime(now)) throw new AutopilotStoreError("invalid_input");
    return this.sqlite.query("UPDATE autopilot_decisions SET reviewed_at=? WHERE id=? AND status='escalated' AND reviewed_at IS NULL")
      .run(now,id).changes === 1;
  }
  releaseSuggestionClaim(id: number, claimedAt: number): boolean {
    if (!Number.isSafeInteger(id) || id < 1 || !isSafeTime(claimedAt)) throw new AutopilotStoreError("invalid_input");
    return this.sqlite.query("UPDATE autopilot_decisions SET reviewed_at=NULL WHERE id=? AND status='escalated' AND reviewed_at=?")
      .run(id,claimedAt).changes === 1;
  }
  unreviewedDecisionCount(project?: string): number {
    const row = project === undefined
      ? this.sqlite.query("SELECT COUNT(*) AS n FROM autopilot_decisions WHERE reviewed_at IS NULL").get() as Row
      : this.sqlite.query("SELECT COUNT(*) AS n FROM autopilot_decisions WHERE reviewed_at IS NULL AND project=?").get(project) as Row;
    return num(row.n);
  }
  markAllReviewed(now = Date.now(), project?: string): number {
    if (!isSafeTime(now) || project !== undefined && typeof project !== "string") throw new AutopilotStoreError("invalid_input");
    return (project === undefined
      ? this.sqlite.query("UPDATE autopilot_decisions SET reviewed_at=? WHERE reviewed_at IS NULL").run(now)
      : this.sqlite.query("UPDATE autopilot_decisions SET reviewed_at=? WHERE reviewed_at IS NULL AND project=?").run(now,project)).changes;
  }
  lastBriefAt(): number {
    const value = this.setting("autopilot.brief_at");
    return value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  }
  setLastBriefAt(value: number): void {
    if (!isSafeTime(value)) throw new AutopilotStoreError("invalid_input");
    this.setSetting("autopilot.brief_at",String(value));
  }
  pruneDecisions(now = Date.now(), batch = 500): number {
    if (!isSafeTime(now) || !Number.isSafeInteger(batch) || batch < 1 || batch > 5_000) throw new AutopilotStoreError("invalid_input");
    const cutoff = now - AUTOPILOT_RETENTION_MS;
    let totalRemoved = 0;
    for (;;) {
      const removed = this.sqlite.transaction(() => {
        const count = this.sqlite.query(`DELETE FROM autopilot_decisions WHERE id IN (
          SELECT id FROM autopilot_decisions WHERE decided_at<? ORDER BY decided_at,id LIMIT ?
        )`).run(cutoff,batch).changes;
        this.sqlite.query(`UPDATE autopilot_goals SET last_verdict_json=NULL,last_verdict_at=NULL
          WHERE last_verdict_at IS NOT NULL AND last_verdict_at<?`).run(cutoff);
        return count;
      })();
      totalRemoved += removed;
      if (removed < batch) return totalRemoved;
    }
  }
}

export function actorForGoal(goalId: number): string {
  if (!Number.isSafeInteger(goalId) || goalId < 1) throw new AutopilotStoreError("invalid_input");
  return `autopilot:goal:${goalId}`;
}

export function goalIdFromActor(actor: string): number | null { return goalActorId(actor); }

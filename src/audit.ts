import { createHash } from "node:crypto";
import { redact } from "./redact.ts";
import type { ReplyAuditListener, ReplySource } from "./db.ts";

export type ReplyAuditInput = {
  ts: number;
  replyId?: number | null;
  sessionKey: string;
  source: ReplySource;
  actor: string;
  listener: ReplyAuditListener;
  text: string;
  outcome?: string | null;
  outcomeTs?: number | null;
  goalId?: number | null;
  rule?: string | null;
};

export type PreparedAuditContext = {
  ts: number;
  replyId?: number | null;
  sessionKey: string;
  source: ReplySource;
  actor: string;
  listener: ReplyAuditListener;
  textSha256: string;
  textRedacted: string;
  outcome?: string | null;
  outcomeTs?: number | null;
  goalId?: number | null;
  rule?: string | null;
};

export type ReplyAuditInsert = {
  ts: number;
  replyId: number | null;
  sessionKey: string;
  source: ReplySource;
  actor: string;
  listener: ReplyAuditListener;
  textSha256: string;
  textRedacted: string;
  outcome: string | null;
  outcomeTs: number | null;
  goalId: number | null;
  rule: string | null;
};

export type ReplyAuditDTO = Omit<ReplyAuditInsert, "textSha256"> & { id: number };

export interface AuditStore {
  insertAudit(entry: ReplyAuditInsert): number;
  listAudit(key: string, limit?: number): ReplyAuditDTO[];
  pruneAudit(now: number): number;
}

export function prepareAudit(entry: ReplyAuditInput): PreparedAuditContext {
  return {
    ts: entry.ts,
    replyId: entry.replyId ?? null,
    sessionKey: entry.sessionKey,
    source: entry.source,
    actor: entry.actor,
    listener: entry.listener,
    textSha256: createHash("sha256").update(entry.text).digest("hex"),
    textRedacted: [...redact(entry.text)].slice(0, 500).join(""),
    outcome: entry.outcome ?? null,
    outcomeTs: entry.outcomeTs ?? null,
    goalId: entry.goalId ?? null,
    rule: entry.rule ?? null,
  };
}

export function createAudit(db: AuditStore) {
  return {
    prepare: prepareAudit,
    record(entry: ReplyAuditInput): number {
      const prepared = prepareAudit(entry);
      return db.insertAudit({
        ts: prepared.ts,
        replyId: prepared.replyId ?? null,
        sessionKey: prepared.sessionKey,
        source: prepared.source,
        actor: prepared.actor,
        listener: prepared.listener,
        textSha256: prepared.textSha256,
        textRedacted: prepared.textRedacted,
        outcome: prepared.outcome ?? null,
        outcomeTs: prepared.outcomeTs ?? null,
        goalId: prepared.goalId ?? null,
        rule: prepared.rule ?? null,
      });
    },
    list(key: string, limit = 100): ReplyAuditDTO[] {
      return db.listAudit(key, limit);
    },
    prune(now: number): number {
      return db.pruneAudit(now);
    },
  };
}

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashDB } from "../src/db.ts";

test("Telegram settings round-trip through SQLite and can be deleted", () => {
  const db = new DashDB(":memory:");
  try {
    expect(db.getSetting("telegram.chat_id")).toBeUndefined();

    db.setSetting("telegram.chat_id", "12345");
    db.setSetting("telegram.mode", "turns");
    expect(db.getSetting("telegram.chat_id")).toBe("12345");
    expect(db.getSetting("telegram.mode")).toBe("turns");

    db.setSetting("telegram.mode", "input");
    expect(db.getSetting("telegram.mode")).toBe("input");

    db.deleteSetting("telegram.chat_id");
    expect(db.getSetting("telegram.chat_id")).toBeUndefined();
    expect(db.getSetting("telegram.mode")).toBe("input");
  } finally {
    db.close();
  }
});

test("settings prefix deletion treats underscores literally", () => {
  const db = new DashDB(":memory:");
  try {
    db.setSetting("telegram.mode.invest", "turns");
    db.setSetting("telegram.mode.squad_rogue", "off");
    db.setSetting("telegram.modeX.rogue", "input");
    expect(db.deleteSettingsPrefix("telegram.mode.")).toBe(2);
    expect(db.getSetting("telegram.mode.invest")).toBeUndefined();
    expect(db.getSetting("telegram.mode.squad_rogue")).toBeUndefined();
    expect(db.getSetting("telegram.modeX.rogue")).toBe("input");
  } finally {
    db.close();
  }
});

function createPreStep4aDatabase(path: string, pairedChatId?: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','leased','delivered','expired','cancelled')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      lease_until INTEGER,
      done_at INTEGER,
      tg_msg_id INTEGER
    );
    CREATE TABLE tg_alerts (
      message_id INTEGER PRIMARY KEY,
      session_key TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('alert','digest')),
      sent_at INTEGER NOT NULL
    );
  `);
  if (pairedChatId !== undefined) legacy.query("INSERT INTO settings(k,v) VALUES('telegram.chat_id',?)").run(pairedChatId);
  legacy.query(`INSERT INTO replies(session_key,text,state,created_at,expires_at,tg_msg_id)
    VALUES('synthetic-session','synthetic reply','queued',100,1000,88)`).run();
  legacy.query("INSERT INTO tg_alerts(message_id,session_key,kind,sent_at) VALUES(7,'synthetic-session','alert',100)").run();
  legacy.close();
}

test("pre-4a alert and reply references migrate to the paired DM id and reopen idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-telegram-migration-"));
  const path = join(dir, "db.sqlite");
  createPreStep4aDatabase(path, "12345");
  let db = new DashDB(path, { topicsEnabled: true });
  try {
    const replyColumns = db.sqlite.query("PRAGMA table_info(replies)").all() as { name: string }[];
    expect(replyColumns.map(column => column.name)).toContain("tg_chat_id");
    const alertColumns = db.sqlite.query("PRAGMA table_info(tg_alerts)").all() as { name: string; pk: number }[];
    expect(alertColumns.find(column => column.name === "chat_id")?.pk).toBe(1);
    expect(alertColumns.find(column => column.name === "message_id")?.pk).toBe(2);
    expect(db.alertFor("12345", 7)).toEqual({ sessionKey: "synthetic-session", kind: "alert" });
    expect(db.getReply(1)).toMatchObject({
      text: "synthetic reply", state: "queued", tgMsgId: 88, tgChatId: "12345",
    });
  } finally {
    db.close();
  }

  db = new DashDB(path, { topicsEnabled: true });
  db.close();
  db = new DashDB(path);
  try {
    expect(db.alertFor("12345", 7)).toEqual({ sessionKey: "synthetic-session", kind: "alert" });
    expect(db.getReply(1)?.tgChatId).toBe("12345");
    db.rememberAlert("12345", 8, "flag-off-session", "alert", 200);
    expect(db.alertFor("12345", 8)).toEqual({ sessionKey: "flag-off-session", kind: "alert" });
    db.setReplyTgMsg(1, "12345", 89);
    expect(db.getReply(1)).toMatchObject({ tgChatId: "12345", tgMsgId: 89 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy references migrate on their first flag-off database open", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-telegram-flag-off-migration-"));
  const path = join(dir, "db.sqlite");
  createPreStep4aDatabase(path, "54321");
  const db = new DashDB(path, { topicsEnabled: false });
  try {
    const replyColumns = db.sqlite.query("PRAGMA table_info(replies)").all() as { name: string }[];
    expect(replyColumns.map(column => column.name)).toContain("tg_chat_id");
    const alertColumns = db.sqlite.query("PRAGMA table_info(tg_alerts)").all() as { name: string; pk: number }[];
    expect(alertColumns.find(column => column.name === "chat_id")?.pk).toBe(1);
    expect(alertColumns.find(column => column.name === "message_id")?.pk).toBe(2);
    expect(db.getReply(1)).toMatchObject({ text: "synthetic reply", state: "queued", tgChatId: "54321" });
    expect(db.alertFor("54321", 7)).toEqual({ sessionKey: "synthetic-session", kind: "alert" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-4a references without a paired owner receive the unreachable empty sentinel", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-telegram-unpaired-"));
  const path = join(dir, "db.sqlite");
  createPreStep4aDatabase(path);
  const db = new DashDB(path);
  try {
    expect(db.alertFor("", 7)).toEqual({ sessionKey: "synthetic-session", kind: "alert" });
    db.setSetting("telegram.chat_id", "67890");
    expect(db.alertFor("67890", 7)).toBeUndefined();
    expect(db.getReply(1)?.tgChatId).toBe("");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("alerts are scoped by chat while seven-day pruning remains global", () => {
  const db = new DashDB(":memory:");
  const now = 10 * 86400_000;
  try {
    db.rememberAlert("111", 6, "old", "alert", now - 7 * 86400_000 - 1);
    db.rememberAlert("111", 7, "dm-session", "alert", now - 10);
    db.rememberAlert("-100222", 7, "group-session", "alert", now);
    expect(db.alertFor("111", 7)).toEqual({ sessionKey: "dm-session", kind: "alert" });
    expect(db.alertFor("-100222", 7)).toEqual({ sessionKey: "group-session", kind: "alert" });
    expect(db.alertFor("333", 7)).toBeUndefined();
    expect(db.alertFor("111", 6)).toBeUndefined();
  } finally {
    db.close();
  }
});

test("urgent episodes persist, reset on a new episode, and mark at most once", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-urgent-episodes-"));
  const path = join(dir, "db.sqlite");
  let db = new DashDB(path);
  db.startUrgentEpisode("synthetic-session", 100);
  expect(db.dueUrgentEpisodes(30_100, 30_000)).toEqual([]);
  expect(db.dueUrgentEpisodes(30_101, 30_000)).toEqual([
    { sessionKey: "synthetic-session", startedAt: 100, repagedAt: null },
  ]);
  expect(db.markUrgentRepaged("synthetic-session", 30_101)).toBe(true);
  expect(db.markUrgentRepaged("synthetic-session", 30_102)).toBe(false);
  db.close();

  db = new DashDB(path);
  try {
    expect(db.hasUrgentEpisode("synthetic-session")).toBe(true);
    expect(db.dueUrgentEpisodes(60_000, 30_000)).toEqual([]);
    db.startUrgentEpisode("synthetic-session", 40_000);
    expect(db.dueUrgentEpisodes(70_001, 30_000)).toHaveLength(1);
    db.endUrgentEpisode("synthetic-session");
    expect(db.hasUrgentEpisode("synthetic-session")).toBe(false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confirmed missing sessions are distinct from hook-only sessions", () => {
  const db = new DashDB(":memory:");
  const host = "synthetic-host";
  const hookKey = `${host}|omp|hook-only`;
  const missingKey = `${host}|omp|confirmed-missing`;
  try {
    db.applyEvent({ host, harness: "omp", sessionId: "hook-only", kind: "prompt", ts: 100, interactive: true });
    expect(db.isConfirmedMissingSession(hookKey)).toBe(false);

    const observed = [{ host, harness: "omp" as const, sessionId: "confirmed-missing", pid: 321 }];
    db.markLiveness("omp", observed, host, 200, () => false);
    expect(db.isConfirmedMissingSession(missingKey)).toBe(false);
    db.markLiveness("omp", [], host, 201, () => false);
    expect(db.isConfirmedMissingSession(missingKey)).toBe(true);
    expect(db.isConfirmedMissingSession(hookKey)).toBe(false);
  } finally {
    db.close();
  }
});

const MULTI = "Two calls to make:\n\n1. Which DB?\n   (a) Postgres\n   (b) SQLite\n2. **Deploy target:** B is my pick.\n   A. Fly\n   B. Railway\n   C. Render\n";
const respond = (db: DashDB, sessionId: string, ts: number, text = MULTI) => {
  const dto = db.applyEvent({ host:"synthetic-host", harness:"claude", sessionId, kind:"response", ts, text, interactive:true });
  return { key:dto.key, turnSeq:dto.turnSeq, responseId:db.responseForTurn(dto.key, dto.turnSeq)!.id };
};
const intent = (db: DashDB, r: { key: string; turnSeq: number; responseId: number }, chatId: string, threadId: number | null = null, now = 1000) => {
  const created = db.createCardIntent(r.key, r.responseId, r.turnSeq, { chatId, threadId }, now);
  if (created === "card_id_overflow") throw new Error("unexpected overflow");
  return created;
};

test("R4 tg_cards is created on a pre-4a database and reopens idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-cards-legacy-"));
  const path = join(dir, "db.sqlite");
  createPreStep4aDatabase(path, "12345");
  let db = new DashDB(path, { decisionsEnabled: true });
  try {
    const indexes = (db.sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tg_cards'").all() as { name: string }[]).map(i => i.name);
    expect(indexes).toEqual(expect.arrayContaining(["tg_cards_session_turn", "tg_cards_expiry", "tg_cards_reply"]));
    expect(db.alertFor("12345", 7)).toEqual({ sessionKey: "synthetic-session", kind: "alert" });
    const { card } = intent(db, respond(db, "legacy", 1000), "12345");
    expect(card).toMatchObject({ id: 1, state: "pending", messageId: null, expiresAt: 1000 + 86_400_000, picks: {} });
    db.close();
    db = new DashDB(path);
    expect(db.getCard(1)?.state).toBe("pending");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R4 a card keeps its picks and real chat/thread/message across reopen, and ids are never reused", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-cards-reopen-"));
  const path = join(dir, "db.sqlite");
  let db = new DashDB(path, { decisionsEnabled: true });
  try {
    const turn = respond(db, "cards", 1000);
    const first = intent(db, turn, "-100222", 5);
    expect(first.created).toBe(true);
    expect(intent(db, turn, "-100999")).toEqual({ created: false, card: first.card });
    const id = first.card.id;
    expect(db.togglePick(id, 0, 1)).toBeUndefined();
    expect(db.activateCard(id, { chatId: "-100333", threadId: 7, messageId: 42 })).toBe(true);
    expect(db.activateCard(id, { chatId: "111", threadId: null, messageId: 43 })).toBe(false);
    expect(db.togglePick(id, 1, 2)?.picks).toEqual({ "1": 2 });
    expect(db.togglePick(id, 0, 1)?.picks).toEqual({ "0": 1, "1": 2 });
    expect(db.togglePick(id, 1, 2)?.picks).toEqual({ "0": 1 });
    for (const [g, o] of [[2, 0], [0, 2], [0, -1], [0, 1.5], [-1, 0]]) expect(db.togglePick(id, g, o)).toBeUndefined();
    db.close();

    db = new DashDB(path, { decisionsEnabled: true });
    const card = db.getCard(id)!;
    expect(card).toMatchObject({ chatId: "-100333", threadId: 7, messageId: 42, picks: { "0": 1 }, state: "active", turnSeq: 1, responseId: turn.responseId });
    expect(card.decisions.decisions.map(d => [d.title, d.recIndex])).toEqual([["Which DB?", null], ["Deploy target", 1]]);
    const second = intent(db, respond(db, "cards", 1001, "synthetic second turn"), "-100222");
    expect(second.card.id).toBe(id + 1);
    db.sqlite.query("DELETE FROM tg_cards WHERE id=?").run(second.card.id);
    db.close();

    db = new DashDB(path, { decisionsEnabled: true });
    expect(intent(db, respond(db, "cards", 1002, "synthetic third turn"), "-100222").card.id).toBe(id + 2);
    db.sqlite.query("UPDATE sqlite_sequence SET seq=? WHERE name='tg_cards'").run(36 ** 8 - 1);
    const fourth = respond(db, "cards", 1003, "synthetic fourth turn");
    expect(db.createCardIntent(fourth.key, fourth.responseId, fourth.turnSeq, { chatId: "-100222", threadId: null }, 1003)).toBe("card_id_overflow");
    expect(db.cardForTurn(fourth.key, fourth.turnSeq)).toBeUndefined();
    db.sqlite.query("UPDATE sqlite_sequence SET seq=? WHERE name='tg_cards'").run(36 ** 8 - 2);
    expect(intent(db, fourth, "-100222").card.id.toString(36)).toBe("zzzzzzzz");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R4 the same numeric message_id in a DM and a group never cross-routes card state", () => {
  const db = new DashDB(":memory:", { decisionsEnabled: true });
  try {
    const dm = intent(db, respond(db, "dm", 1000), "111").card, group = intent(db, respond(db, "group", 1001), "-100222", 4).card;
    db.activateCard(dm.id, { chatId: "111", threadId: null, messageId: 9 });
    db.activateCard(group.id, { chatId: "-100222", threadId: 4, messageId: 9 });
    expect(db.togglePick(dm.id, 0, 0)?.picks).toEqual({ "0": 0 });
    expect(db.markCardSent(dm.id, 31)).toBe(true);
    expect(db.getCard(group.id)).toMatchObject({ chatId: "-100222", threadId: 4, messageId: 9, picks: {}, state: "active", replyId: null });
    expect(db.getCard(dm.id)).toMatchObject({ chatId: "111", threadId: null, messageId: 9, state: "sent", replyId: 31 });
    expect(db.cardForReply(31)?.id).toBe(dm.id);
    expect(db.cardForReply(32)).toBeUndefined();
    expect(db.cardForTurn("synthetic-host|claude|group", 1)?.id).toBe(group.id);
  } finally {
    db.close();
  }
});

test("R4 card lifecycle: turn-guarded picks, one send, monotonic states, decision-less rows and pruning", () => {
  const db = new DashDB(":memory:", { decisionsEnabled: true, judgeEnabled: true });
  try {
    const plain = respond(db, "plain", 1000, "synthetic status update"), pending = respond(db, "pending", 1001, "Should I keep the queue or drop it?");
    const bare = intent(db, plain, "111").card;
    expect(bare.decisions).toEqual({ decisions: [], source: "parser" });
    expect(intent(db, pending, "111").card.decisions).toEqual({ decisions: [], source: "parser" });
    db.activateCard(bare.id, { chatId: "111", threadId: null, messageId: 1 });
    expect(db.togglePick(bare.id, 0, 0)).toBeUndefined();

    const turn = respond(db, "moved", 1002), card = intent(db, turn, "111").card;
    expect(db.repointCard(card.id, { chatId: "-100222", threadId: 3, messageId: 2 })).toBe(true);
    expect(db.getCard(card.id)).toMatchObject({ state: "pending", chatId: "-100222", threadId: 3, messageId: 2 });
    db.activateCard(card.id, { chatId: "111", threadId: null, messageId: 2 });
    db.sqlite.query("UPDATE tg_cards SET picks_json=? WHERE id=?").run("{\"0\":9}", card.id);
    expect(db.getCard(card.id)?.picks).toBeNull();
    expect(db.togglePick(card.id, 0, 0)).toBeUndefined();
    db.sqlite.query("UPDATE tg_cards SET picks_json='{}' WHERE id=?").run(card.id);
    db.applyEvent({ host: "synthetic-host", harness: "claude", sessionId: "moved", kind: "error", ts: 1003, text: "synthetic error", interactive: true });
    expect(db.togglePick(card.id, 0, 0)).toBeUndefined();
    expect(db.markCardState(card.id, "stale")).toBe(true);
    expect(db.markCardState(card.id, "active")).toBe(false);
    expect(db.markCardSent(card.id, 5)).toBe(false);

    expect(db.markCardSent(bare.id, 6)).toBe(true);
    expect(db.markCardSent(bare.id, 7)).toBe(false);
    expect(db.markCardState(bare.id, "stale")).toBe(false);
    expect(db.getCard(bare.id)).toMatchObject({ state: "sent", replyId: 6 });

    const live = db.getCard(intent(db, pending, "111").card.id)!;
    expect(live.state).toBe("pending");
    expect(db.pruneCards(1000 + 86_400_000 - 1)).toBe(0);
    expect(db.getCard(live.id)?.state).toBe("pending");
    expect(db.pruneCards(1000 + 86_400_000)).toBe(0);
    expect(db.getCard(live.id)?.state).toBe("expired");
    expect(db.getCard(bare.id)?.state).toBe("sent");
    expect(db.pruneCards(1000 + 8 * 86_400_000)).toBe(0);
    expect(db.pruneCards(1001 + 8 * 86_400_000)).toBe(3);
    expect(db.getCard(live.id)).toBeUndefined();
  } finally {
    db.close();
  }
});

test("latest AskUserQuestion detail is read back for the session", () => {
  const db = new DashDB(":memory:");
  try {
    const base = { host: "synthetic-host", harness: "claude" as const, sessionId: "ask", interactive: true }, now = Date.now();
    expect(db.latestQuestionDetail("synthetic-host|claude|ask")).toBeUndefined();
    db.applyEvent({ ...base, kind: "question", ts: now, text: "First?", detail: "[[{\"label\":\"One\"}]]" });
    db.applyEvent({ ...base, kind: "question", ts: now + 1, text: "Second?", detail: "[[{\"label\":\"Two (Recommended)\"}]]" });
    expect(db.latestQuestionDetail("synthetic-host|claude|ask")).toBe("[[{\"label\":\"Two (Recommended)\"}]]");
  } finally {
    db.close();
  }
});

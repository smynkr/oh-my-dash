import { hostname, homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { openSync, fstatSync, readSync, closeSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { describePrompt, resolveWorkspacePath, stripAgyPromptEnvelope } from "./normalize.ts";

export interface BackfillResponse { ts: number; text: string; prompt?: string }
export interface BackfillSession {
  host: string; harness: "claude" | "omp" | "agy"; sessionId: string; cwd?: string; title?: string;
  transcriptPath: string; interactive: boolean; responses: BackfillResponse[];
}

const MAX_TAIL = 16 * 1024 * 1024;
const INITIAL_TAIL = 4 * 1024 * 1024;
const shortHost = hostname().split(".")[0] || hostname();
const object = (v: unknown): Record<string, any> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;

function tailLines(path: string, maxBytes: number): string[] {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, info.size - length);
    const data = buffer.toString("utf8");
    const firstNewline = data.indexOf("\n");
    return (info.size > length && firstNewline >= 0 ? data.slice(firstNewline + 1) : data).split(/\r?\n/).filter(Boolean);
  } finally { closeSync(fd); }
}
function headEntries(path: string): Record<string, any>[] {
  const fd = openSync(path, "r");
  try {
    const size = Math.min(fstatSync(fd).size, INITIAL_TAIL);
    const data = Buffer.alloc(size);
    readSync(fd, data, 0, size, 0);
    const entries: Record<string, any>[] = [];
    for (const line of data.toString("utf8").split(/\r?\n/)) try { const entry = object(JSON.parse(line)); if (entry) entries.push(entry); } catch { /* incomplete line */ }
    return entries;
  } finally { closeSync(fd); }
}
function parseLines(path: string, isOmp: boolean, maxBytes: number): BackfillSession | null {
  let fileSize = 0;
  try { fileSize = statSync(path).size; } catch { return null; }
  const head = headEntries(path);
  // OMP's `session` metadata marks nested agent transcripts; never surface them.
  if (isOmp && head.some(e => e.type === "session" && (e.parentSession || e.session?.parentSession))) return null;
  // Claude eligibility is in the header, so reject before doing the much larger tail read.
  if (!isOmp && head.find(e => Object.hasOwn(e, "entrypoint"))?.entrypoint !== "cli") return null;
  let lines: string[];
  try { lines = tailLines(path, maxBytes); } catch { return null; }
  const entries: Record<string, any>[] = [];
  for (const line of lines) { try { const e = object(JSON.parse(line)); if (e) entries.push(e); } catch { /* partial or malformed tail line */ } }
  if (!entries.length) return null;
  const messages = entries.filter(e => isOmp ? e.type === "message" && ["user", "assistant"].includes(e.message?.role) : ["user", "assistant"].includes(e.type));
  const textOf = (entry: Record<string, any>): string => {
    const msg = isOmp ? entry.message : entry.message;
    const content = msg?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
    return "";
  };
  const eligibleUser = (entry: Record<string, any>) => {
    const msg = entry.message;
    if (!isOmp && (entry.isSidechain === true || entry.isMeta === true)) return false;
    if (isOmp) return entry.message?.role === "user" && textOf(entry).length > 0;
    return entry.type === "user" && (typeof msg?.content === "string" || (Array.isArray(msg?.content) && msg.content.some((b: any) => typeof b?.text === "string")));
  };
  const turns: { user: Record<string, any>; assistants: Record<string, any>[] }[] = [];
  for (const entry of messages) {
    if (!isOmp && (entry.isSidechain === true || entry.isMeta === true)) continue;
    if (eligibleUser(entry)) turns.push({ user: entry, assistants: [] });
    else if (turns.length && (isOmp ? entry.message?.role === "assistant" : entry.type === "assistant")) turns.at(-1)!.assistants.push(entry);
  }
  const responses: BackfillResponse[] = [];
  for (const turn of turns.slice(-3)) {
    let selected: Record<string, any>[] = [];
    const byId = new Map<string, Record<string, any>[]>();
    for (const a of turn.assistants) {
      const id = isOmp ? String(turn.assistants.indexOf(a)) : String(a.message?.id ?? a.id ?? "");
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id)!.push(a);
    }
    for (const group of [...byId.values()].reverse()) {
      if (group.some(a => textOf(a).length)) { selected = group; break; }
    }
    const text = selected.map(textOf).join("");
    if (!text) continue;
    const stamp = selected.at(-1)?.timestamp ?? selected.at(-1)?.ts ?? turn.user.timestamp ?? turn.user.ts;
    const parsed = typeof stamp === "number" ? (stamp < 1e12 ? stamp * 1000 : stamp) : Date.parse(stamp ?? "");
    const prompt = describePrompt(textOf(turn.user));
    responses.push({ ts: Number.isFinite(parsed) ? parsed : Date.now(), text, ...(prompt ? { prompt } : {}) });
  }
  if (responses.length < 3 && fileSize > INITIAL_TAIL && maxBytes < MAX_TAIL) return parseLines(path, isOmp, MAX_TAIL);
  const last3 = responses;
  const meta = isOmp ? head.find(e => e.type === "session") ?? entries.find(e => e.type === "session") : undefined;
  const titleEntry = isOmp ? [...head, ...entries].reverse().find(e => e.type === "title" || e.type === "title_change") : [...head, ...entries].reverse().find(e => e.type === "ai-title");
  const title = isOmp ? (titleEntry?.title ?? meta?.title ?? meta?.session?.title) : titleEntry?.aiTitle;
  const cwd = isOmp ? (meta?.cwd ?? meta?.session?.cwd) : (head.find(e => typeof e.cwd === "string") ?? entries.find(e => typeof e.cwd === "string"))?.cwd;
  const sessionId = isOmp ? (meta?.id ?? meta?.session?.id ?? basename(path, ".jsonl")) : (head.find(e => e.sessionId) ?? entries.find(e => e.sessionId))?.sessionId ?? basename(path, ".jsonl");
  return { host: shortHost, harness: isOmp ? "omp" : "claude", sessionId, cwd, title, transcriptPath: path, interactive: true, responses: last3 };
}
export function parseClaudeTranscript(path: string): BackfillSession | null { return parseLines(path, false, INITIAL_TAIL); }
export function parseOmpTranscript(path: string): BackfillSession | null { return parseLines(path, true, INITIAL_TAIL); }

export async function findClaudeTranscript(sessionId: string): Promise<BackfillSession | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const root = join(homedir(), ".claude/projects");
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const path = join(root, project.name, `${sessionId}.jsonl`);
    try { if ((await stat(path)).isFile()) return parseClaudeTranscript(path); } catch { /* no matching transcript here */ }
  }
  return null;
}

export function defaultAgyRoots(home = homedir(), env = process.env): string[] {
  const configured = env.DASH_AGY_HOME?.trim();
  if (configured) return configured.split(":").map(s => s.trim()).filter(Boolean);
  return [
    join(home, ".gemini/antigravity-cli"),
    join(home, ".gemini/antigravity"),
    join(home, ".gemini/antigravity-ide"),
  ];
}
export function parseAgyTimestamp(value: unknown): number {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value !== "string" || !value.trim()) return NaN;
  const iso = value.trim()
    .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, "$1T$2")
    .replace(/(\.\d{3})\d+/, "$1");
  return Date.parse(iso);
}
const SAFE_AGY_ID = /^[A-Za-z0-9_-]{1,128}$/;

function parseAgyLines(
  path: string,
  maxBytes: number,
  meta?: { sessionId?: string; cwd?: string; title?: string; host?: string; requireUserEnvelope?: boolean },
): BackfillSession | null {
  let fileSize = 0;
  try { fileSize = statSync(path).size; } catch { return null; }
  let lines: string[];
  try { lines = tailLines(path, maxBytes); } catch { return null; }
  const entries: Record<string, any>[] = [];
  for (const line of lines) { try { const e = object(JSON.parse(line)); if (e) entries.push(e); } catch { /* partial or malformed line */ } }
  if (!entries.length) return null;
  const neededFull = new Set<number>();
  for (const e of entries) {
    if ((e.type === "USER_INPUT" || e.type === "PLANNER_RESPONSE") && Number.isInteger(e.step_index) &&
      Array.isArray(e.truncated_fields) && e.truncated_fields.includes("content")) {
      neededFull.add(e.step_index);
    }
  }
  const fullContent = new Map<number, string>();
  if (neededFull.size > 0) {
    const fullPath = join(dirname(path), "transcript_full.jsonl");
    try {
      for (const line of tailLines(fullPath, MAX_TAIL)) {
        try {
          const e = object(JSON.parse(line));
          if (e && Number.isInteger(e.step_index) && neededFull.has(e.step_index) && typeof e.content === "string") {
            fullContent.set(e.step_index, e.content);
          }
        } catch { /* ignore malformed full transcript line */ }
      }
    } catch { /* transcript_full.jsonl is optional */ }
  }
  const contentOf = (e: Record<string, any>): string => {
    if (Number.isInteger(e.step_index) && fullContent.has(e.step_index)) return fullContent.get(e.step_index)!;
    return typeof e.content === "string" ? e.content : "";
  };
  if (meta?.requireUserEnvelope && !entries.some(e => e.type === "USER_INPUT" && contentOf(e).includes("<USER_REQUEST>"))) {
    return fileSize > INITIAL_TAIL && maxBytes < MAX_TAIL ? parseAgyLines(path, MAX_TAIL, meta) : null;
  }
  const turns: { user: Record<string, any>; promptText: string; planners: { entry: Record<string, any>; text: string }[] }[] = [];
  for (const e of entries) {
    if (e.type === "USER_INPUT" && (e.source === "USER_EXPLICIT" || e.source === undefined)) {
      const stripped = stripAgyPromptEnvelope(contentOf(e));
      if (stripped) turns.push({ user: e, promptText: stripped, planners: [] });
    } else if (turns.length && e.type === "PLANNER_RESPONSE") {
      const text = contentOf(e);
      if (text.trim()) turns.at(-1)!.planners.push({ entry: e, text });
    }
  }
  const responses: BackfillResponse[] = [];
  for (const turn of turns.slice(-3)) {
    const last = turn.planners.at(-1);
    if (!last) continue;
    const parsed = parseAgyTimestamp(last.entry.created_at ?? last.entry.timestamp ?? turn.user.created_at ?? turn.user.timestamp);
    const prompt = describePrompt(turn.promptText);
    responses.push({ ts: Number.isFinite(parsed) ? parsed : Date.now(), text: last.text, ...(prompt ? { prompt } : {}) });
  }
  if (responses.length < 3 && fileSize > INITIAL_TAIL && maxBytes < MAX_TAIL) return parseAgyLines(path, MAX_TAIL, meta);
  const match = path.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/);
  const sessionId = meta?.sessionId ?? match?.[1] ?? basename(path, ".jsonl");
  return {
    host: meta?.host ?? shortHost,
    harness: "agy",
    sessionId,
    ...(meta?.cwd ? { cwd: meta.cwd } : {}),
    ...(meta?.title ? { title: meta.title } : {}),
    transcriptPath: path,
    interactive: true,
    responses,
  };
}
export function parseAgyTranscript(path: string, meta?: { sessionId?: string; cwd?: string; title?: string; host?: string }): BackfillSession | null {
  return parseAgyLines(path, INITIAL_TAIL, meta);
}
export async function findAgyTranscript(sessionId: string, agyRoots = defaultAgyRoots()): Promise<BackfillSession | null> {
  if (!SAFE_AGY_ID.test(sessionId)) return null;
  for (const root of agyRoots) {
    const transcriptPath = join(root, "brain", sessionId, ".system_generated/logs/transcript.jsonl");
    try { if (!(await stat(transcriptPath)).isFile()) continue; } catch { continue; }
    let cwd: string | undefined, title: string | undefined;
    const dbPath = join(root, "conversation_summaries.db");
    let db: Database | undefined;
    try {
      if (statSync(dbPath).isFile()) {
        db = new Database(dbPath, { readonly: true });
        const row = db.query("SELECT title, workspace_uris FROM conversation_summaries WHERE conversation_id = ?").get(sessionId) as Record<string, any> | null;
        if (row) {
          cwd = resolveWorkspacePath(row.workspace_uris);
          title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : undefined;
        }
      }
    } catch { /* optional metadata */ }
    finally { try { db?.close(); } catch { /* ignore */ } }
    const parsed = parseAgyTranscript(transcriptPath, { sessionId, cwd, title });
    if (parsed) return parsed;
  }
  return null;
}
export async function scanAgyBackfill(cutoff: number, agyRoots = defaultAgyRoots()): Promise<BackfillSession[]> {
  const byId = new Map<string, { mtime: number; session: BackfillSession }>();
  for (const root of agyRoots) {
    const seenInRoot = new Set<string>();
    const dbPath = join(root, "conversation_summaries.db");
    let hasDb = false;
    try { hasDb = statSync(dbPath).isFile(); } catch { hasDb = false; }
    if (hasDb) {
      let rows: Array<Record<string, any>> = [];
      let db: Database | undefined;
      try {
        db = new Database(dbPath, { readonly: true });
        rows = db.query(
          "SELECT conversation_id, title, workspace_uris, last_modified_time, nesting_depth, parent_conversation_id, killed FROM conversation_summaries WHERE killed = 0 AND nesting_depth = 0"
        ).all() as Array<Record<string, any>>;
      } catch { rows = []; }
      finally { try { db?.close(); } catch { /* ignore */ } }
      for (const row of rows) {
        const id = typeof row.conversation_id === "string" ? row.conversation_id.trim() : "";
        if (!SAFE_AGY_ID.test(id) || (typeof row.parent_conversation_id === "string" && row.parent_conversation_id.trim())) continue;
        seenInRoot.add(id);
        const modMs = parseAgyTimestamp(row.last_modified_time);
        if (Number.isFinite(modMs) && modMs < cutoff) continue;
        const transcriptPath = join(root, "brain", id, ".system_generated/logs/transcript.jsonl");
        let mtimeMs = modMs;
        try {
          const st = await stat(transcriptPath);
          if (!st.isFile()) continue;
          if (!Number.isFinite(mtimeMs)) mtimeMs = st.mtimeMs;
          if (mtimeMs < cutoff && st.mtimeMs < cutoff) continue;
        } catch { continue; }
        const cwd = resolveWorkspacePath(row.workspace_uris);
        const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : undefined;
        const parsed = parseAgyTranscript(transcriptPath, { sessionId: id, cwd, title });
        if (!parsed) continue;
        const prev = byId.get(id);
        if (!prev || mtimeMs >= prev.mtime) byId.set(id, { mtime: mtimeMs, session: parsed });
      }
    }
    const brainDir = join(root, "brain");
    let entries;
    try { entries = await readdir(brainDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_AGY_ID.test(entry.name) || seenInRoot.has(entry.name)) continue;
      if (hasDb) continue;
      const transcriptPath = join(brainDir, entry.name, ".system_generated/logs/transcript.jsonl");
      let st;
      try { st = await stat(transcriptPath); } catch { continue; }
      if (!st.isFile() || st.mtimeMs < cutoff) continue;
      const parsed = parseAgyLines(transcriptPath, INITIAL_TAIL, { sessionId: entry.name, requireUserEnvelope: true });
      if (!parsed) continue;
      const prev = byId.get(entry.name);
      if (!prev || st.mtimeMs >= prev.mtime) byId.set(entry.name, { mtime: st.mtimeMs, session: parsed });
    }
  }
  return [...byId.values()].map(v => v.session);
}

async function filesUnder(dir: string, predicate: (p: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(path: string): Promise<void> { let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const p = join(path, e.name); if (e.isDirectory()) await walk(p); else if (predicate(p)) out.push(p); }
  }
  await walk(dir); return out;
}
export async function scanBackfill(hours = Number(process.env.DASH_BACKFILL_HOURS ?? 12), options: { roots?: { path: string; omp: boolean; sessionsDepth?: boolean }[]; agyRoots?: string[]; now?: number } = {}): Promise<BackfillSession[]> {
  const cutoff = (options.now ?? Date.now()) - Math.max(0, hours) * 3600_000;
  const roots = options.roots ?? [
    { path: join(homedir(), ".claude/projects"), omp: false },
    { path: join(homedir(), ".omp/agent/sessions"), omp: true, sessionsDepth: true },
    { path: join(homedir(), ".omp/agent-deck"), omp: true },
  ];
  const results: BackfillSession[] = [];
  for (const root of roots) for (const path of await filesUnder(root.path, p => {
    if (!p.endsWith(".jsonl") || p.split("/").includes("subagents")) return false;
    if (root.sessionsDepth) return p.slice(root.path.length + 1).split("/").length === 2;
    return true;
  })) {
    try { if ((await stat(path)).mtimeMs < cutoff) continue; } catch { continue; }
    const parsed = await parseLines(path, root.omp, INITIAL_TAIL);
    if (parsed) results.push(parsed);
  }
  const agyRoots = options.agyRoots ?? (options.roots ? [] : defaultAgyRoots());
  if (agyRoots.length) results.push(...await scanAgyBackfill(cutoff, agyRoots));
  return results;
}

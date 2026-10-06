import { hostname } from "node:os";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { readdir, stat } from "node:fs/promises";
import { openSync, fstatSync, readSync, closeSync, statSync } from "node:fs";
import { describePrompt } from "./normalize.ts";

export interface BackfillResponse { ts: number; text: string; prompt?: string }
export interface BackfillSession {
  host: string; harness: "claude" | "omp"; sessionId: string; cwd?: string; title?: string;
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

async function filesUnder(dir: string, predicate: (p: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(path: string): Promise<void> { let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const p = join(path, e.name); if (e.isDirectory()) await walk(p); else if (predicate(p)) out.push(p); }
  }
  await walk(dir); return out;
}
export async function scanBackfill(hours = Number(process.env.DASH_BACKFILL_HOURS ?? 12), options: { roots?: { path: string; omp: boolean; sessionsDepth?: boolean }[]; now?: number } = {}): Promise<BackfillSession[]> {
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
  return results;
}

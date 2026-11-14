import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { defaultAgyRoots } from "./backfill.ts";
import { resolveWorkspacePath } from "./normalize.ts";

export interface LivenessRecord {
  host: string; harness: "claude" | "omp" | "codex" | "agy"; sessionId: string; pid?: number;
  cwd?: string; name?: string; detail?: string;
}
const execFileAsync = promisify(execFile);
const host = hostname().split(".")[0] || hostname();
let claudeBinPromise: Promise<string | null> | undefined;
type ResolverExec = (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string }>;
export async function resolveClaudeBin(exec: ResolverExec = execFileAsync, env = process.env, home = homedir()): Promise<string> {
  const configured = env.DASH_CLAUDE_BIN?.trim();
  if (configured?.startsWith("/")) return configured;
  try {
    const { stdout } = await exec("/bin/zsh", ["-lc", "whence -p claude"], { timeout: 5000, maxBuffer: 64 * 1024 });
    const candidate = stdout.trim().split(/\r?\n/).at(-1)?.trim();
    if (candidate && candidate.startsWith("/")) return candidate;
  } catch { /* use the documented local install fallback */ }
  return join(home, ".local/bin/claude");
}
async function resolveClaude(): Promise<string> {
  if (!claudeBinPromise) claudeBinPromise = resolveClaudeBin();
  return claudeBinPromise;
}
export async function pollClaudeAgents(): Promise<LivenessRecord[]> {
  const bin = await resolveClaude();
  const { stdout } = await execFileAsync(bin, ["agents", "--json"], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  return parseClaudeAgents(JSON.parse(stdout), host);
}
export function parseClaudeAgents(parsed: unknown, host: string): LivenessRecord[] {
  const agents = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { agents?: unknown }).agents : undefined;
  if (!Array.isArray(parsed) && !Array.isArray(agents)) throw new Error("Invalid Claude agents response");
  const records = Array.isArray(parsed) ? parsed : agents as unknown[];
  return records.flatMap((r: any) => typeof r?.sessionId === "string" ? [{
    host, harness: "claude" as const, sessionId: r.sessionId,
    ...(Number.isInteger(r.pid) ? { pid: r.pid } : {}), ...(typeof r.cwd === "string" ? { cwd: r.cwd } : {}),
    ...(typeof r.name === "string" ? { name: r.name } : {}), ...(typeof r.status === "string" ? { detail: r.status } : {}),
  }] : []);
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } }
export async function pollOmpPresence(): Promise<LivenessRecord[] | null> {
  const base = join(homedir(), ".omp");
  const records: LivenessRecord[] = [];
  let supported = false;
  const clientsRoot = join(base, "run/daemons");
  try {
    for (const daemon of await readdir(clientsRoot, { withFileTypes: true })) {
      if (!daemon.isDirectory()) continue;
      const clients = join(clientsRoot, daemon.name, "clients");
      let names: string[]; try { names = await readdir(clients); } catch { continue; }
      for (const name of names.filter(n => n.endsWith(".json"))) {
        try {
          const v = JSON.parse(await readFile(join(clients, name), "utf8"));
          if (!Number.isInteger(v?.pid) || !pidAlive(v.pid)) continue;
          // Daemon-client `id` is a client identity, not a transcript session ID.
          const id = typeof v.sessionId === "string" ? v.sessionId : undefined;
          if (!id) continue;
          supported = true;
          records.push({ host, harness: "omp", sessionId: id, pid: v.pid, ...(typeof v.cwd === "string" ? { cwd: v.cwd } : typeof v.projectDir === "string" ? { cwd: v.projectDir } : {}), ...(typeof v.name === "string" ? { name: v.name } : {}) });
        } catch { /* ignore malformed presence entry */ }
      }
    }
  } catch { /* absent daemon directory */ }
  // Terminal-session filenames are tty identifiers; their contents don't reliably map to an OMP session.
  // If daemon client records expose no usable session ids, preserve unknown rather than infer one.
  const terminals = join(base, "agent/terminal-sessions");
  try { const entries = await readdir(terminals); if (entries.length) supported ||= false; } catch { /* optional */ }
  return supported ? records : null;
}

function normalizeAgyDetail(status: unknown, notFullyIdle?: unknown): string | undefined {
  if (status === "CASCADE_RUN_STATUS_RUNNING" || Number(notFullyIdle) === 1 || notFullyIdle === true) return "busy";
  if (status === "CASCADE_RUN_STATUS_IDLE") return "idle";
  if (typeof status === "string" && status.trim()) return status.trim();
  return undefined;
}

export function parseAgyAgents(parsed: unknown, hostName: string): LivenessRecord[] {
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(obj?.agents) ? obj.agents : Array.isArray(obj?.sessions) ? obj.sessions : undefined;
  if (!list) throw new Error("Invalid Antigravity agents response");
  return list.flatMap((r: any) => {
    if (!r || typeof r !== "object") return [];
    const sessionId = typeof r.sessionId === "string" ? r.sessionId
      : typeof r.conversationId === "string" ? r.conversationId
      : typeof r.conversation_id === "string" ? r.conversation_id : undefined;
    if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return [];
    if (Number(r.nestingDepth ?? r.nesting_depth ?? 0) > 0 || Boolean(r.killed)) return [];
    if (typeof (r.parentConversationId ?? r.parent_conversation_id) === "string" && (r.parentConversationId ?? r.parent_conversation_id).trim()) return [];
    const cwd = resolveWorkspacePath(r.cwd) ?? resolveWorkspacePath(r.workspaceUris ?? r.workspace_uris);
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : typeof r.title === "string" && r.title.trim() ? r.title.trim() : undefined;
    const detail = normalizeAgyDetail(r.detail ?? r.status, r.notFullyIdle ?? r.not_fully_idle);
    return [{
      host: hostName, harness: "agy" as const, sessionId,
      ...(Number.isInteger(r.pid) ? { pid: r.pid } : {}),
      ...(cwd ? { cwd } : {}),
      ...(name ? { name } : {}),
      ...(detail ? { detail } : {}),
    }];
  });
}

const AGY_FLOCK_SCRIPT = [
  "import fcntl, json, os, sys",
  "out = []",
  "for root in sys.argv[1:]:",
  "    pdir = os.path.join(root, 'presence')",
  "    try: names = os.listdir(pdir)",
  "    except FileNotFoundError: continue",
  "    for name in names:",
  "        if not name.endswith('.lock'): continue",
  "        path = os.path.join(pdir, name)",
  "        try: fd = os.open(path, os.O_RDONLY)",
  "        except FileNotFoundError: continue",
  "        try:",
  "            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
  "            fcntl.flock(fd, fcntl.LOCK_UN)",
  "        except BlockingIOError:",
  "            out.append([root, name[:-5]])",
  "        finally:",
  "            os.close(fd)",
  "print(json.dumps(out))",
].join("\n");

export async function pollAgySessions(options: { roots?: string[]; host?: string; pythonBin?: string } = {}): Promise<LivenessRecord[] | null> {
  const roots = (options.roots ?? defaultAgyRoots()).filter(root => {
    try { return statSync(join(root, "presence")).isDirectory(); } catch { return false; }
  });
  if (!roots.length) return null;
  const targetHost = options.host ?? host;
  const pythonBin = options.pythonBin ?? "/usr/bin/python3";
  let lockedPairs: Array<[string, string]>;
  try {
    const { stdout } = await execFileAsync(pythonBin, ["-c", AGY_FLOCK_SCRIPT, ...roots], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    lockedPairs = parsed.filter((item): item is [string, string] =>
      Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item[1])
    );
  } catch {
    return null;
  }
  if (!lockedPairs.length) return [];
  const byRoot = new Map<string, string[]>();
  for (const [root, id] of lockedPairs) {
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(id);
  }
  const seen = new Set<string>();
  const records: LivenessRecord[] = [];
  for (const [root, ids] of byRoot) {
    const summaryById = new Map<string, Record<string, any>>();
    const dbPath = join(root, "conversation_summaries.db");
    let hasDb = false;
    try { hasDb = statSync(dbPath).isFile(); } catch { hasDb = false; }
    if (hasDb && ids.length) {
      let db: Database | undefined;
      try {
        db = new Database(dbPath, { readonly: true });
        const placeholders = ids.map(() => "?").join(",");
        const rows = db.query(
          `SELECT conversation_id, title, workspace_uris, status, nesting_depth, parent_conversation_id, killed, not_fully_idle FROM conversation_summaries WHERE conversation_id IN (${placeholders})`
        ).all(...ids) as Array<Record<string, any>>;
        for (const row of rows) {
          if (typeof row.conversation_id === "string") summaryById.set(row.conversation_id, row);
        }
      } catch { /* summary DB is optional enrichment */ }
      finally { try { db?.close(); } catch { /* ignore */ } }
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      const row = summaryById.get(id);
      if (row) {
        if (Number(row.nesting_depth ?? 0) > 0 || Number(row.killed ?? 0) !== 0) continue;
        if (typeof row.parent_conversation_id === "string" && row.parent_conversation_id.trim()) continue;
      }
      seen.add(id);
      const cwd = row ? resolveWorkspacePath(row.workspace_uris) : undefined;
      const name = row && typeof row.title === "string" && row.title.trim() ? row.title.trim() : undefined;
      const detail = row ? normalizeAgyDetail(row.status, row.not_fully_idle) : undefined;
      records.push({
        host: targetHost,
        harness: "agy",
        sessionId: id,
        ...(cwd ? { cwd } : {}),
        ...(name ? { name } : {}),
        ...(detail ? { detail } : {}),
      });
    }
  }
  return records;
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";

export interface LivenessRecord {
  host: string; harness: "claude" | "omp"; sessionId: string; pid?: number;
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

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type JudgeErrorKind = "spawn" | "timeout" | "usage_limit" | "exit" | "invalid_json" | "schema" | "closed" | "skipped";
export class JudgeError extends Error {
  constructor(readonly kind: JudgeErrorKind, readonly exitCode?: number) {
    super(exitCode === undefined ? `judge ${kind}` : `judge ${kind} (exit ${exitCode})`);
    this.name = "JudgeError";
  }
}
export type JudgeModel = "gpt-6-luna" | "gpt-reserve";
// stillWanted is re-checked after the queue wait and before every spawn; false skips the run without spawning.
export type JudgeOptions = { model?: JudgeModel; timeoutMs?: number; stillWanted?: () => boolean };
export type Judge = { judge<T>(prompt: string, schema: object, options?: JudgeOptions): Promise<T>; close(): void };

const STDERR_CAP = 64 * 1024;
const KILL_GRACE_MS = 2000;
const STDERR_DRAIN_MS = 1000;
// Source evidence, codex-cli 0.160.1 (openai/codex tag rust-v0.160.1 = d27764b8): exec's human output prints
// `"ERROR:".style(red).style(bold)` + " " + TurnError.message (exec/src/event_processor_with_human_output.rs:254,330),
// and UsageLimitReachedError's Display always begins `You’ve hit your usage limit` with U+2019 followed by `.`,
// ` for <limit>` or the plan suffix (protocol/src/error.rs:707-790). Styles are plain when stderr is not a tty;
// ANSI SGR codes are stripped before matching anyway. Re-check when the CLI version changes.
export const USAGE_LIMIT_LINE = /^ERROR: You’ve hit your usage limit(?:\b|[., ])/;
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

export function judgeArgv(bin: string, model: JudgeModel, dir: string): readonly string[] {
  return Object.freeze([bin, "exec", "-m", model, "-c", "model_reasoning_effort=max", "-c", 'web_search="disabled"',
    "-s", "read-only", "--skip-git-repo-check", "--ignore-user-config",
    "--output-schema", join(dir, "schema.json"), "--output-last-message", join(dir, "last-message.json"), "-"]);
}

const ANNOTATIONS = new Set(["$schema", "title", "description"]);
const KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"]);
function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case "object": return !!v && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    default: return false;
  }
}
// Deliberately partial JSON Schema: any keyword outside the supported set fails closed instead of being ignored.
export function matchesSchema(schema: unknown, v: unknown): boolean {
  if (schema === true) return true;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const s = schema as Record<string, any>;
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) return false;
  if (s.type !== undefined && !(Array.isArray(s.type) ? s.type : [s.type]).some((t: unknown) => typeof t === "string" && typeOk(t, v))) return false;
  if (s.enum !== undefined && !(Array.isArray(s.enum) && s.enum.some((e: unknown) => e === v))) return false;
  if ("const" in s && s.const !== v) return false;
  if (typeof v === "string") {
    const n = [...v].length;
    if ((s.minLength !== undefined && n < s.minLength) || (s.maxLength !== undefined && n > s.maxLength)) return false;
  }
  if (typeof v === "number" && ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum))) return false;
  if (Array.isArray(v)) {
    if ((s.minItems !== undefined && v.length < s.minItems) || (s.maxItems !== undefined && v.length > s.maxItems)) return false;
    if (s.items !== undefined && !v.every(item => matchesSchema(s.items, item))) return false;
  }
  if (typeOk("object", v)) {
    const o = v as Record<string, unknown>, props = s.properties ?? {};
    if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((k: unknown) => typeof k === "string" && Object.hasOwn(o, k)))) return false;
    for (const [k, val] of Object.entries(o)) {
      if (Object.hasOwn(props, k)) { if (!matchesSchema(props[k], val)) return false; }
      else if (s.additionalProperties !== undefined && !matchesSchema(s.additionalProperties, val)) return false;
    }
  }
  return true;
}

// Classifies complete stderr lines as they stream; memory stays bounded however much the child writes.
function watchStderr(stream: ReadableStream<Uint8Array>, onUsageLimit: () => void) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let line = "", overflow = false;
  const check = (text: string) => { if (!overflow && USAGE_LIMIT_LINE.test(text.replace(ANSI_SGR, "").replace(/\r$/, ""))) onUsageLimit(); };
  const done = (async () => {
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        const parts = (line + decoder.decode(r.value, { stream: true })).split("\n");
        line = parts.pop() ?? "";
        for (const part of parts) { check(part); overflow = false; }
        if (line.length > STDERR_CAP) { line = ""; overflow = true; }
      }
      check(line + decoder.decode());
    } catch { /* a broken or cancelled stderr pipe only loses classification */ }
  })();
  return { done, cancel: () => reader.cancel().catch(() => {}) };
}

export function sweepJudgeDirs(dataDir: string) {
  const root = join(dataDir, "judge");
  let names: string[]; try { names = readdirSync(root); } catch { return; }
  for (const name of names) if (name.startsWith("j-")) { try { rmSync(join(root, name), { recursive: true, force: true }); } catch { /* best effort */ } }
}

export function createJudge(options: { bin?: string; dataDir?: string; maxConcurrent?: number } = {}): Judge {
  const bin = options.bin ?? "codex";
  const dataDir = resolve(options.dataDir ?? process.env.DASH_DATA ?? "data");
  const root = join(dataDir, "judge");
  const max = Math.max(1, options.maxConcurrent ?? 2);
  const waiting: Array<{ start: () => void; cancel: () => void }> = [];
  const running = new Set<() => void>();
  let active = 0, closed = false;
  sweepJudgeDirs(dataDir);

  function acquire(): Promise<void> {
    if (closed) return Promise.reject(new JudgeError("closed"));
    if (active < max) { active++; return Promise.resolve(); }
    return new Promise((start, reject) => waiting.push({ start: () => { active++; start(); }, cancel: () => reject(new JudgeError("closed")) }));
  }
  function release() { active--; waiting.shift()?.start(); }

  async function attempt(prompt: string, schema: object, model: JudgeModel, timeoutMs: number): Promise<unknown> {
    if (closed) throw new JudgeError("closed");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(root, "j-"));
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false, cancelled = false, usageLimit = false;
    // codex runs in its own process group, so a timeout or close() also stops the commands it started.
    const killGroup = (signal: NodeJS.Signals) => {
      if (!proc) return;
      try { process.kill(-proc.pid, signal); } catch { try { proc.kill(signal); } catch { /* already reaped */ } }
    };
    const stop = () => {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
      killGroup("SIGTERM");
      killTimer ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const cancel = () => { cancelled = true; stop(); };
    try {
      await chmod(dir, 0o700);
      await writeFile(join(dir, "schema.json"), JSON.stringify(schema), { mode: 0o600, flag: "wx" });
      if (closed) throw new JudgeError("closed");
      try {
        proc = Bun.spawn([...judgeArgv(bin, model, dir)], { cwd: dir, stdin: "pipe", stdout: "ignore", stderr: "pipe", detached: true });
      } catch { throw new JudgeError("spawn"); }
      running.add(cancel);
      const child = proc, stderr = watchStderr(child.stderr as ReadableStream<Uint8Array>, () => { usageLimit = true; });
      timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      // Never await stdin on its own: a child that stops reading must still hit the timeout path.
      (async () => { child.stdin.write(prompt); await child.stdin.end(); })().catch(() => { /* an early exit is classified below */ });
      const code = await child.exited;
      // An orphaned grandchild can hold stderr open past the child's exit; stop reading after a short drain.
      if (await Promise.race([stderr.done.then(() => true), Bun.sleep(STDERR_DRAIN_MS).then(() => false)]) === false) stderr.cancel();
      if (cancelled) throw new JudgeError("closed");
      if (timedOut) throw new JudgeError("timeout");
      if (code !== 0) throw usageLimit ? new JudgeError("usage_limit", code) : new JudgeError("exit", code);
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(join(dir, "last-message.json"), "utf8")); } catch { throw new JudgeError("invalid_json"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new JudgeError("invalid_json");
      if (!matchesSchema(schema, parsed)) throw new JudgeError("schema");
      return parsed;
    } finally {
      clearTimeout(timer);
      if (proc && proc.exitCode === null && proc.signalCode === null) { killGroup("SIGKILL"); await proc.exited; }
      // Leftover group members (shell commands codex started) never outlive the run; the leader is already reaped.
      if (proc && (timedOut || cancelled)) killGroup("SIGKILL");
      clearTimeout(killTimer);
      running.delete(cancel);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    async judge<T>(prompt: string, schema: object, opts: JudgeOptions = {}): Promise<T> {
      const model = opts.model ?? "gpt-6-luna", timeoutMs = opts.timeoutMs ?? 180_000;
      await acquire();
      const wanted = () => { if (opts.stillWanted && !opts.stillWanted()) throw new JudgeError("skipped"); };
      try {
        try { wanted(); return await attempt(prompt, schema, model, timeoutMs) as T; }
        catch (e) {
          if (!(e instanceof JudgeError) || e.kind !== "usage_limit" || model === "gpt-reserve") throw e;
          wanted();
          return await attempt(prompt, schema, "gpt-reserve", timeoutMs) as T;
        }
      } catch (e) { throw e instanceof JudgeError ? e : new JudgeError("spawn"); }
      finally { release(); }
    },
    close() {
      closed = true;
      for (const w of waiting.splice(0)) w.cancel();
      for (const cancel of running) cancel();
    },
  };
}

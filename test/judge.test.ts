import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createJudge, type Judge, JudgeError, judgeArgv, matchesSchema, USAGE_LIMIT_LINE } from "../src/judge.ts";

// Frozen from codex-cli 0.160.1 source (protocol/src/error.rs plan-less formatter, exec human-output `ERROR:` prefix).
const USAGE_LINE = "ERROR: You’ve hit your usage limit. Try again later.";
const SCHEMA = { type: "object", additionalProperties: false, required: ["choice"], properties: { choice: { type: "string", maxLength: 20 } } };

let dir: string, fake: string, dataDir: string;
const judges: Judge[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dash-judge-"));
  dataDir = join(dir, "data");
  fake = join(dir, "codex");
  mkdirSync(join(dir, "calls"));
  // Records argv, cwd, schema mode and stdin EOF per call; behavior comes from the `mode` file.
  writeFileSync(fake, `#!/bin/sh
F='${dir}'
d="$F/calls/$$"; mkdir "$d"
for a in "$@"; do printf '%s\\n' "$a" >> "$d/argv"; done
pwd -P > "$d/cwd"; ls -A > "$d/ls"; ls -ld . > "$d/perm-dir"; ls -l schema.json > "$d/perm-schema"; cp schema.json "$d/schema"
cat > "$d/stdin"; echo eof > "$d/eof"
out=""; model=""; prev=""
for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; [ "$prev" = "-m" ] && model="$a"; prev="$a"; done
echo "$model" > "$d/model"
mode=$(cat "$F/mode")
case "$mode" in
  ok) printf '{"choice":"B"}' > "$out" ;;
  usage) printf 'progress\\n${USAGE_LINE}\\n' >&2; exit 1 ;;
  usage-once) if [ "$model" = gpt-6-luna ]; then printf '${USAGE_LINE}\\n' >&2; exit 1; fi; printf '{"choice":"B"}' > "$out" ;;
  ratelimit) printf 'ERROR: 429 Too Many Requests: rate limit reached\\nYou’ve hit your usage limit\\n' >&2; exit 1 ;;
  usage-ok) printf '${USAGE_LINE}\\n' >&2; printf '{"choice":"B"}' > "$out" ;;
  exit) printf 'stderr secret tokenaaaa:bbbb\\n' >&2; exit 3 ;;
  sleep) exec sleep 30 ;;
  grandchild) (trap '' TERM; exec sleep 31) & echo $! > "$F/gc"; exec sleep 30 ;;
  badjson) printf 'not json' > "$out" ;;
  empty) : > "$out" ;;
  array) printf '[1]' > "$out" ;;
  schema) printf '{"choice":"B","extra":1}' > "$out" ;;
  flood) head -c 3000000 /dev/zero | tr '\\0' x >&2; printf '\\n${USAGE_LINE}\\n' >&2; exit 1 ;;
  slow) p=$(cat "$d/stdin"); echo "start $p" >> "$F/order"; if [ "$p" = p2 ]; then i=0; while [ $i -lt 300 ] && ! grep -qx "start p4" "$F/order"; do sleep 0.05; i=$((i+1)); done; else sleep 0.2; fi; echo "end $p" >> "$F/order"; printf '{"choice":"B"}' > "$out" ;;
esac
`);
  chmodSync(fake, 0o755);
});
afterEach(() => { for (const j of judges.splice(0)) j.close(); rmSync(dir, { recursive: true, force: true }); });

const mode = (m: string) => writeFileSync(join(dir, "mode"), m);
const make = (maxConcurrent?: number) => { const j = createJudge({ bin: fake, dataDir, maxConcurrent }); judges.push(j); return j; };
const calls = () => readdirSync(join(dir, "calls")).map(id => {
  const read = (f: string) => existsSync(join(dir, "calls", id, f)) ? readFileSync(join(dir, "calls", id, f), "utf8") : undefined;
  return { argv: read("argv")?.trimEnd().split("\n") ?? [], cwd: read("cwd")?.trim(), ls: read("ls"), model: read("model")?.trim(),
    stdin: read("stdin"), eof: read("eof") === "eof\n", permDir: read("perm-dir"), permSchema: read("perm-schema"), schema: read("schema") };
});
const judgeDirs = () => existsSync(join(dataDir, "judge")) ? readdirSync(join(dataDir, "judge")) : [];
async function failure(p: Promise<unknown>): Promise<JudgeError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(JudgeError); return e as JudgeError; }
  throw new Error("expected JudgeError");
}

describe("judge runner", () => {
  test("spawns only the fake with the exact R2 argv, an empty private cwd, stdin EOF, and parses last-message.json", async () => {
    mode("ok");
    expect(await make().judge<{ choice: string }>("synthetic prompt", SCHEMA)).toEqual({ choice: "B" });
    const [call] = calls();
    expect(calls()).toHaveLength(1);
    const jd = dirname(call!.argv[12]!);
    expect(jd.startsWith(join(dataDir, "judge", "j-"))).toBe(true);
    expect(call!.cwd).toBe(join(realpathSync(join(dataDir, "judge")), basename(jd)));
    expect(call!.argv).toEqual(["exec", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=max", "-c", 'web_search="disabled"',
      "-s", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--output-schema", join(jd, "schema.json"),
      "--output-last-message", join(jd, "last-message.json"), "-"]);
    expect(call!.ls).toBe("schema.json\n");
    expect(call!.permDir).toMatch(/^drwx------/);
    expect(call!.permSchema).toMatch(/^-rw-------/);
    expect(JSON.parse(call!.schema!)).toEqual(SCHEMA);
    expect(call!.stdin).toBe("synthetic prompt");
    expect(call!.eof).toBe(true);
    expect(judgeDirs()).toEqual([]);
  });

  test("judgeArgv is frozen and differs between models only in -m", () => {
    const a = judgeArgv("/bin/fake", "gpt-6-luna", "/d"), b = judgeArgv("/bin/fake", "gpt-reserve", "/d");
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.map((v, i) => v === b[i] ? null : [v, b[i]]).filter(Boolean)).toEqual([["gpt-6-luna", "gpt-reserve"]]);
  });

  test("usage-limit line retries exactly once with gpt-reserve in a fresh directory", async () => {
    mode("usage-once");
    expect(await make().judge("p", SCHEMA)).toEqual({ choice: "B" });
    const cs = calls();
    expect(cs.map(c => c.model).sort()).toEqual(["gpt-6-luna", "gpt-reserve"]);
    expect(new Set(cs.map(c => c.cwd)).size).toBe(2);
    expect(cs.every(c => c.stdin === "p" && c.eof)).toBe(true);
    expect(judgeDirs()).toEqual([]);
  });

  test("a second usage limit returns usage_limit after two attempts total", async () => {
    mode("usage");
    const e = await failure(make().judge("p", SCHEMA));
    expect(e.kind).toBe("usage_limit");
    expect(e.exitCode).toBe(1);
    expect(calls().map(c => c.model).sort()).toEqual(["gpt-6-luna", "gpt-reserve"]);
    expect(judgeDirs()).toEqual([]);
  });

  test("an explicit gpt-reserve call never retries", async () => {
    mode("usage");
    expect((await failure(make().judge("p", SCHEMA, { model: "gpt-reserve" }))).kind).toBe("usage_limit");
    expect(calls()).toHaveLength(1);
  });

  test("429/rate-limit text and an unanchored usage phrase are plain exit, no retry", async () => {
    mode("ratelimit");
    const e = await failure(make().judge("p", SCHEMA));
    expect([e.kind, e.exitCode]).toEqual(["exit", 1]);
    expect(calls()).toHaveLength(1);
  });

  test("a usage line with exit 0 still parses the output", async () => {
    mode("usage-ok");
    expect(await make().judge("p", SCHEMA)).toEqual({ choice: "B" });
    expect(calls()).toHaveLength(1);
  });

  test("nonzero exit, malformed output and schema mismatch each yield their kind with no retry and no leaked text", async () => {
    const j = make();
    for (const [m, kind] of [["exit", "exit"], ["badjson", "invalid_json"], ["empty", "invalid_json"], ["array", "invalid_json"], ["schema", "schema"]] as const) {
      mode(m);
      const before = calls().length;
      const e = await failure(j.judge("prompt secret tokenaaaa:bbbb", SCHEMA));
      expect(e.kind).toBe(kind);
      expect(calls().length - before).toBe(1);
      expect(e.message).not.toMatch(/secret|tokenaaaa|prompt|not json|choice/);
    }
    expect(judgeDirs()).toEqual([]);
  });

  test("spawn failure of a missing or non-executable binary is spawn", async () => {
    const missing = createJudge({ bin: join(dir, "absent"), dataDir }); judges.push(missing);
    expect((await failure(missing.judge("p", SCHEMA))).kind).toBe("spawn");
    const plain = join(dir, "plain"); writeFileSync(plain, "#!/bin/sh\n");
    const noexec = createJudge({ bin: plain, dataDir }); judges.push(noexec);
    expect((await failure(noexec.judge("p", SCHEMA))).kind).toBe("spawn");
    expect(judgeDirs()).toEqual([]);
  });

  test("timeout kills and reaps the child, removes the directory and does not retry", async () => {
    mode("sleep");
    const started = Date.now();
    const e = await failure(make().judge("p", SCHEMA, { timeoutMs: 1500 }));
    expect(e.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(6000);
    expect(calls()).toHaveLength(1);
    // The fake execs sleep under its own pid (the calls/<pid> directory), so a live pid would be an unreaped child.
    const pid = Number(readdirSync(join(dir, "calls"))[0]);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(judgeDirs()).toEqual([]);
  });

  test("timeout and close() kill the whole process group, including commands codex started", async () => {
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const grandchild = async () => {
      // Generous waits: under heavy machine load the fake can take seconds to reach its fork.
      for (let i = 0; i < 1000 && !existsSync(join(dir, "gc")); i++) await Bun.sleep(20);
      return Number(readFileSync(join(dir, "gc"), "utf8"));
    };
    mode("grandchild");
    const e = await failure(make().judge("p", SCHEMA, { timeoutMs: 4000 }));
    expect(e.kind).toBe("timeout");
    const first = await grandchild();
    for (let i = 0; i < 1000 && alive(first); i++) await Bun.sleep(20);
    expect(alive(first)).toBe(false);
    rmSync(join(dir, "gc"));
    const j = make();
    const running = j.judge("p", SCHEMA, { timeoutMs: 20_000 });
    const second = await grandchild();
    expect(alive(second)).toBe(true);
    j.close();
    expect((await failure(running)).kind).toBe("closed");
    for (let i = 0; i < 1000 && alive(second); i++) await Bun.sleep(20);
    expect(alive(second)).toBe(false);
    expect(judgeDirs()).toEqual([]);
  }, 60_000);

  test("stillWanted is re-checked after the queue wait and a false answer spawns nothing", async () => {
    mode("slow");
    const j = make(1);
    expect((await failure(j.judge("p0", SCHEMA, { stillWanted: () => false }))).kind).toBe("skipped");
    let wanted = true;
    const first = j.judge("p1", SCHEMA);
    const queued = j.judge("p2", SCHEMA, { stillWanted: () => wanted });
    wanted = false;
    await first;
    expect((await failure(queued)).kind).toBe("skipped");
    expect(calls().map(c => c.stdin)).toEqual(["p1"]);
    expect(judgeDirs()).toEqual([]);
  });

  test("a multi-megabyte stderr flood does not deadlock and still classifies the final complete line", async () => {
    mode("flood");
    const e = await failure(make().judge("p", SCHEMA, { timeoutMs: 20_000 }));
    expect(e.kind).toBe("usage_limit");
    expect(calls()).toHaveLength(2);
  });

  test("FIFO with a concurrency cap of 2", async () => {
    mode("slow");
    const j = make(2);
    const results = await Promise.all(["p1", "p2", "p3", "p4"].map(p => j.judge(p, SCHEMA)));
    expect(results).toHaveLength(4);
    const order = readFileSync(join(dir, "order"), "utf8").trim().split("\n");
    let running = 0, peak = 0;
    for (const line of order) { running += line.startsWith("start") ? 1 : -1; peak = Math.max(peak, running); }
    expect(peak).toBe(2);
    const starts = order.filter(l => l.startsWith("start")).map(l => l.slice(6));
    expect(starts.slice(2)).toEqual(["p3", "p4"]);
    // p2 holds its slot until p4 has started (capped at 15 s), so the queue must hand p1's slot to p3 and then p3's
    // slot to p4 while p2 still runs; a cap of 1 or a non-FIFO queue still fails these checks, only more slowly.
    expect(order.indexOf("start p3")).toBeGreaterThan(order.indexOf("end p1"));
    expect(order.indexOf("start p4")).toBeGreaterThan(order.indexOf("end p3"));
    expect(order.indexOf("end p2")).toBeGreaterThan(order.indexOf("start p4"));
    expect(judgeDirs()).toEqual([]);
  });

  test("close() rejects waiters without spawning, kills running children, and refuses new work", async () => {
    mode("sleep");
    const j = make(1);
    const running = j.judge("p1", SCHEMA, { timeoutMs: 20_000 });
    const queued = j.judge("p2", SCHEMA, { timeoutMs: 20_000 });
    for (let i = 0; i < 100 && !calls().some(c => c.eof); i++) await Bun.sleep(20);
    j.close();
    expect((await failure(queued)).kind).toBe("closed");
    expect((await failure(running)).kind).toBe("closed");
    expect((await failure(j.judge("p3", SCHEMA))).kind).toBe("closed");
    expect(calls()).toHaveLength(1);
    expect(judgeDirs()).toEqual([]);
  });

  test("startup sweeps leftover judge/j-* directories only", () => {
    mkdirSync(join(dataDir, "judge", "j-leftover", "nested"), { recursive: true });
    writeFileSync(join(dataDir, "judge", "j-leftover", "last-message.json"), "{}");
    mkdirSync(join(dataDir, "judge", "keep"), { recursive: true });
    make();
    expect(judgeDirs()).toEqual(["keep"]);
  });
});

describe("usage-limit classifier and schema subset", () => {
  test("anchored prefix matches the 0.160.1 formatter variants only", () => {
    for (const line of [USAGE_LINE, "ERROR: You’ve hit your usage limit.", "ERROR: You’ve hit your usage limit for synthetic-model. Switch to another model now, or try again later.",
      "ERROR: You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again later."]) expect(USAGE_LIMIT_LINE.test(line)).toBe(true);
    for (const line of ["You’ve hit your usage limit.", "ERROR: You've hit your usage limit.", "ERROR: 429 Too Many Requests", "model said: ERROR: You’ve hit your usage limit.",
      "ERROR: You’ve hit your usage limits"]) expect(USAGE_LIMIT_LINE.test(line)).toBe(false);
  });

  test("supported keywords validate; unsupported keywords fail closed", () => {
    const s = { type: "object", required: ["d"], additionalProperties: false, properties: { d: { type: "array", maxItems: 2, items: {
      type: "object", properties: { i: { type: ["integer", "null"], minimum: 0 }, k: { enum: ["A", "B"] }, t: { type: "string", maxLength: 2 } } } } } };
    expect(matchesSchema(s, { d: [{ i: null, k: "A", t: "😀😀" }, { i: 1 }] })).toBe(true);
    expect(matchesSchema(s, { d: [{ i: -1 }] })).toBe(false);
    expect(matchesSchema(s, { d: [{ i: 1.5 }] })).toBe(false);
    expect(matchesSchema(s, { d: [{ k: "C" }] })).toBe(false);
    expect(matchesSchema(s, { d: [{ t: "abc" }] })).toBe(false);
    expect(matchesSchema(s, { d: [{}, {}, {}] })).toBe(false);
    expect(matchesSchema(s, { d: [], x: 1 })).toBe(false);
    expect(matchesSchema(s, {})).toBe(false);
    expect(matchesSchema({ type: "string", pattern: "^a" }, "a")).toBe(false);
  });
});

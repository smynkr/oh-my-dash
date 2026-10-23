import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const script = join(process.cwd(), "scripts/reply-wait.sh");
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
});

async function runWaiter(base: string, body: string, waitSeconds = "3", python3?: string) {
  const args = ["/bin/sh", script, base, "synthetic-host"];
  if (python3) args.push(python3);
  const proc = Bun.spawn(args, {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, DASH_REPLY_WAIT_S: waitSeconds },
  });
  proc.stdin.write(body);
  proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}

function fake(responses: Array<{ status: number; body?: string; pauseMs?: number }>) {
  let calls = 0;
  const requests: Array<{ url: string; headers: Headers }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push({ url: request.url, headers: new Headers(request.headers) });
      const response = responses[Math.min(calls++, responses.length - 1)];
      if (response.pauseMs) await Bun.sleep(response.pauseMs);
      return new Response(response.body ?? "", { status: response.status });
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, requests, count: () => calls };
}

describe("Claude reply waiter", () => {
  test("a 200 exits 2 and writes only the returned body to stderr", async () => {
    const server = fake([{ status: 200, body: "synthetic reply body" }]);
    const result = await runWaiter(server.base, '{"session_id":"synthetic-session"}');
    expect(result).toEqual({ exitCode: 2, stdout: "", stderr: "synthetic reply body" });
    const url = new URL(server.requests[0].url);
    expect(url.searchParams.get("session")).toBe("synthetic-session");
    expect(url.searchParams.get("waiter")).toMatch(/^[0-9a-f]{16}$/);
    expect(url.searchParams.get("started")).toMatch(/^\d+$/);
    expect(server.requests[0].headers.get("X-Dash-Host")).toBe("synthetic-host");
  });
  test("ordinary JSON that resembles autopilot metadata stays an owner reply", async () => {
    const body = JSON.stringify({ source: "autopilot", text: "synthetic owner JSON" });
    const server = fake([{ status: 200, body }]);
    expect(await runWaiter(server.base, '{"session_id":"synthetic-session"}')).toEqual({
      exitCode: 2, stdout: "", stderr: body,
    });
  });
  test("withholds autopilot text when the durable fence cache cannot be seeded", async () => {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "relative-state";
    const server = fake([{ status: 200, body: JSON.stringify({
      kind: "dash.autopilot.reply.v1", source: "autopilot", text: "synthetic fixed reply",
      autopilot: { goal_id: 1, expires_at: Date.now() + 60_000, remaining_ttl_ms: 60_000 },
    }) }]);
    try {
      expect(await runWaiter(server.base, '{"session_id":"synthetic-session"}')).toEqual({
        exitCode: 0, stdout: "", stderr: "dash autopilot fence cache unavailable; reply withheld\n",
      });
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  });


  test("204 then 200 continues polling", async () => {
    const server = fake([{ status: 204 }, { status: 200, body: "another synthetic reply" }]);
    const result = await runWaiter(server.base, '{"session_id":"synthetic-session"}');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("another synthetic reply");
    expect(server.count()).toBe(2);
  });

  test("409 exits cleanly", async () => {
    const server = fake([{ status: 409 }]);
    expect(await runWaiter(server.base, '{"session_id":"synthetic-session"}')).toMatchObject({ exitCode: 0, stderr: "" });
  });

  test("repeated 204 responses stop at the configured deadline", async () => {
    const server = fake([{ status: 204, pauseMs: 400 }]);
    const start = Date.now();
    const result = await runWaiter(server.base, '{"session_id":"synthetic-session"}', "2");
    expect(result.exitCode).toBe(0);
    expect(server.count()).toBeGreaterThan(1);
    expect(Date.now() - start).toBeLessThan(4000);
  });

  test("missing session id exits without a request", async () => {
    const server = fake([{ status: 200, body: "unused" }]);
    const result = await runWaiter(server.base, '{"other":"value"}');
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(server.count()).toBe(0);
  });

  test("a stopped local server exits by the deadline", async () => {
    const server = fake([{ status: 204 }]);
    const base = server.base;
    servers.pop()?.stop(true);
    const start = Date.now();
    const result = await runWaiter(base, '{"session_id":"synthetic-session"}', "2");
    expect(result.exitCode).toBe(0);
    expect(Date.now() - start).toBeLessThan(4000);
  });
  test("autopilot seeding uses the configured Python executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dash-reply-wait-"));
    const interpreter = join(directory, "custom-python");
    const marker = join(directory, "interpreter-called");
    await writeFile(interpreter, `#!/bin/sh
if [ "$1" = "-c" ]; then
  actual_python=$(command -v python3) || exit 1
  exec "$actual_python" "$@"
fi
cat >/dev/null
printf called > '${marker}'
`);
    await chmod(interpreter, 0o700);
    const server = fake([{ status: 200, body: JSON.stringify({
      kind: "dash.autopilot.reply.v1",
      source: "autopilot", text: "synthetic autopilot reply",
      autopilot: { goal_id: 1, expires_at: Date.now() + 60_000, remaining_ttl_ms: 60_000 },
    }) }]);
    try {
      const result = await runWaiter(server.base, '{"session_id":"synthetic-session"}', "3", interpreter);
      expect(result).toEqual({ exitCode: 2, stdout: "", stderr: "synthetic autopilot reply" });
      expect(await Bun.file(marker).text()).toBe("called");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

});

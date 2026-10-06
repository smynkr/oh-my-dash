import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const script = join(process.cwd(), "scripts/reply-wait.sh");
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
});

async function runWaiter(base: string, body: string, waitSeconds = "3") {
  const proc = Bun.spawn(["/bin/sh", script, base, "synthetic-host"], {
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
});

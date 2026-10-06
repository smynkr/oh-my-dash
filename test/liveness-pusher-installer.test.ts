import { describe, expect, test } from "bun:test";
import { buildPlist, buildScript, install, parseArgs, type Args } from "../scripts/install-liveness-pusher.ts";

const makeArgs = (extra: string[] = []) => parseArgs([
  "--url", "https://hub.example.ts.net:4778/ingest/liveness/claude",
  "--host", "synthetic-mbp",
  "--claude-bin", "/synthetic/bin/claude",
  "--plist", "/private/tmp/synthetic-liveness-push.plist",
  ...extra,
]);

describe("liveness pusher installer", () => {
  test("dry-run shows the endpoint, host, binary, interval, guard, and launchctl commands without executing", async () => {
    const args = makeArgs(["--dry-run", "--interval", "45"]);
    const calls: string[] = [];
    const output = await install(args, async (cmd, argv) => { calls.push(`${cmd} ${argv.join(" ")}`); });
    expect(output).toContain("https://hub.example.ts.net:4778/ingest/liveness/claude");
    expect(output).toContain("X-Dash-Host: synthetic-mbp");
    expect(output).toContain("/synthetic/bin/claude");
    expect(output).toContain("<key>StartInterval</key><integer>45</integer>");
    expect(output).toContain("&amp;&amp;");
    expect(output).toContain("launchctl bootout gui/");
    expect(output).toContain("launchctl bootstrap gui/");
    expect(calls).toEqual([]);
  });

  test("uninstall dry-run prints bootout and rm steps without executing", async () => {
    const args = parseArgs(["--uninstall", "--dry-run", "--claude-bin", "/synthetic/bin/claude", "--plist", "/private/tmp/synthetic-liveness-push.plist"]);
    const calls: string[] = [];
    const output = await install(args, async (cmd, argv) => { calls.push(`${cmd} ${argv.join(" ")}`); });
    expect(output).toContain("launchctl bootout gui/");
    expect(output).toContain("rm '/private/tmp/synthetic-liveness-push.plist'");
    expect(calls).toEqual([]);
  });

  test("XML escapes every special character in string values", () => {
    const args: Args = { ...makeArgs(), claudeBin: `/synthetic/a&b<c>d"e'f` };
    const plist = buildPlist(args);
    for (const escaped of ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"]) expect(plist).toContain(escaped);
    expect(plist).not.toContain("<string>/synthetic/a&b");
  });

  test("script preserves the failure guard so failed Claude output is not posted", () => {
    const script = buildScript(makeArgs());
    expect(script).toContain("agents --json 2>/dev/null) && [ -n \"$out\" ] && printf");
    expect(script).toContain("--data-binary @-");
  });

  test("rejects invalid URL, host, relative binary, and interval", () => {
    const base = ["--url", "https://hub.example/ingest/liveness/claude", "--claude-bin", "/synthetic/claude"];
    expect(() => parseArgs(["--url", "http://hub.example/path", ...base.slice(2)])).toThrow();
    expect(() => parseArgs([...base, "--host", "bad host"])).toThrow();
    expect(() => parseArgs([...base.slice(0, 2), "--claude-bin", "claude"])).toThrow();
    expect(() => parseArgs([...base, "--interval", "9"])).toThrow();
    expect(() => parseArgs([...base, "--interval", "601"])).toThrow();
  });

});

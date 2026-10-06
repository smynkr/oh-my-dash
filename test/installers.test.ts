import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, chmod, lstat, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { mergeSettings, parseArgs as claudeArgs, updateSettings } from "../scripts/install-claude-hooks.ts";
import { install as installOmp, parseArgs as ompArgs } from "../scripts/install-omp-extension.ts";

let scratch: string;
let settings: string;
const original = {
  model: "synthetic-model",
  permissions: { allow: ["Read(/synthetic/**)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "synthetic unrelated command", timeout: 17 }] }],
    SessionStart: [{ hooks: [{ type: "command", command: "synthetic startup" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "synthetic prompt hook" }] }],
  },
};

beforeEach(async () => {
  scratch = await mkdtemp(join(process.cwd(), ".tmp-dash-installers-"));
  settings = join(scratch, "settings.json");
  await writeFile(settings, `${JSON.stringify(original, null, 2)}\n`);
});
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

const args = () => claudeArgs(["--settings", settings, "--url", "http://127.0.0.1:4777/ingest/claude", "--host", "synthetic-host"]);
const settingsDoc = async () => JSON.parse(await readFile(settings, "utf8")) as typeof original;
const backups = async () => (await readdir(scratch)).filter((file) => file.startsWith("settings.json.bak-dash-"));

describe("Claude hook installer", () => {
  test("install adds ten dash groups with a separate async Stop rewake group", async () => {
    await updateSettings(args());
    const hooks = (await settingsDoc()).hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; type: string; async?: boolean; timeout?: number }> }>>;
    const dash = Object.entries(hooks).flatMap(([event, groups]) => groups.filter((group) => group.hooks.some((hook) => hook.command.includes("# dash-hook"))).map((group) => ({ event, group })));
    expect(dash).toHaveLength(10);
    for (const { group } of dash) {
      const ingest = group.hooks.find((hook) => hook.command.includes("X-Dash-Kind:"));
      if (ingest) {
        expect(group.hooks).toHaveLength(1);
        expect(ingest).toMatchObject({ type: "command", async: true, timeout: 5 });
        expect(ingest.command).toContain("# dash-hook");
      }
    }
    const stop = hooks.Stop.at(-1)!;
    expect(stop.hooks).toHaveLength(1);
    expect(stop.hooks[0]).toEqual({ type: "command", async: true, asyncRewake: true, timeout: 21600, command: `/bin/sh '${args().replyScript}' 'http://127.0.0.1:4777' 'synthetic-host' # dash-hook` });
    expect(hooks.PreToolUse.at(-1)?.matcher).toBe("AskUserQuestion");
    expect(hooks.PostToolUse.at(-1)?.matcher).toBe("AskUserQuestion");
  });

  test("install preserves unrelated settings values and creates an original backup", async () => {
    await updateSettings(args());
    const installed = await settingsDoc();
    expect(installed.model).toEqual(original.model);
    expect(installed.permissions).toEqual(original.permissions);
    for (const event of ["PreToolUse", "SessionStart", "UserPromptSubmit"] as const) {
      expect(installed.hooks[event][0]).toEqual(original.hooks[event][0]);
    }
    const saved = await backups();
    expect(saved).toHaveLength(1);
    expect(JSON.parse(await readFile(join(scratch, saved[0]), "utf8"))).toEqual(original);
  });

  test("a second install leaves the settings bytes unchanged", async () => {
    await updateSettings(args());
    const first = await readFile(settings, "utf8");
    await updateSettings(args());
    expect(await readFile(settings, "utf8")).toBe(first);
    expect(await backups()).toHaveLength(1);
  });

  test("reinstall replaces stale dash entries instead of accumulating them", async () => {
    await updateSettings(args());
    const doc = await settingsDoc();
    const start = doc.hooks.SessionStart;
    start[start.length - 1].hooks[0].command = "old synthetic hook # dash-hook";
    await writeFile(settings, JSON.stringify(doc));
    await updateSettings(args());
    const installed = await settingsDoc();
    const startDash = installed.hooks.SessionStart.filter((group) => group.hooks.some((hook) => hook.command.includes("# dash-hook")));
    expect(startDash).toHaveLength(1);
    expect(startDash[0].hooks[0].command).not.toBe("old synthetic hook # dash-hook");
  });

  test("uninstall restores the original document value", async () => {
    await updateSettings(args());
    await updateSettings({ ...args(), uninstall: true });
    expect(await settingsDoc()).toEqual(original);
  });

  test("no-reply omits the rewake hook and uninstall removes both entries", async () => {
    const noReply = claudeArgs(["--settings", settings, "--url", "http://127.0.0.1:4777/ingest/claude", "--host", "synthetic-host", "--no-reply"]);
    const merged = mergeSettings(original, noReply);
    const noReplyStop = (merged.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).Stop;
    expect(noReplyStop).toHaveLength(1);
    expect(noReplyStop[0].hooks[0].command).toContain("X-Dash-Kind:");
    await updateSettings(args());
    await updateSettings({ ...args(), uninstall: true });
    expect(await settingsDoc()).toEqual(original);
  });

  test("reply options reject shell-sensitive values", () => {
    expect(() => claudeArgs(["--reply-base", "https://hub.example/$(touch-nope)"])).toThrow();
    expect(() => claudeArgs(["--url", "https://hub.example/path;touch-nope"])).toThrow();
    expect(() => claudeArgs(["--reply-script", "/tmp/reply;touch-nope"])).toThrow();
  });

  test("keeps pre-existing empty event arrays", async () => {
    const emptyDoc = { ...original, hooks: { ...original.hooks, PostToolUse: [], CustomEvent: [] } };
    await writeFile(settings, JSON.stringify(emptyDoc));
    await updateSettings(args());
    expect((await settingsDoc()).hooks.PostToolUse).toHaveLength(1);
    expect((await settingsDoc()).hooks.CustomEvent).toEqual([]);
  });

  test("writes through a settings symlink and preserves target mode", async () => {
    const target = join(scratch, "settings-target.json");
    const link = join(scratch, "settings-link.json");
    await writeFile(target, `${JSON.stringify(original)}\n`);
    await chmod(target, 0o640);
    await symlink(target, link);
    await updateSettings({ ...claudeArgs(["--settings", link, "--url", "http://127.0.0.1:4777/ingest/claude", "--host", "synthetic-host"]) });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await realpath(link)).toBe(target);
    expect((await lstat(target)).mode & 0o777).toBe(0o640);
    expect(JSON.parse(await readFile(target, "utf8")).hooks.SessionStart.at(-1).hooks[0].command).toContain("# dash-hook");
    expect((await readdir(scratch)).some((name) => name.startsWith("settings-target.json.bak-dash-"))).toBe(true);
  });

  test("backup timestamps use the local calendar and clock", async () => {
    const before = new Date();
    await updateSettings(args());
    const saved = (await backups())[0];
    const after = new Date();
    const stamp = saved.match(/\.bak-dash-(\d{14})/)?.[1];
    expect(stamp).toBeDefined();
    const asDate = new Date(Number(stamp!.slice(0, 4)), Number(stamp!.slice(4, 6)) - 1, Number(stamp!.slice(6, 8)), Number(stamp!.slice(8, 10)), Number(stamp!.slice(10, 12)), Number(stamp!.slice(12, 14)));
    expect(asDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(asDate.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  test("dry-run leaves settings and backups untouched", async () => {
    const first = await readFile(settings, "utf8");
    const result = await updateSettings({ ...args(), dryRun: true });
    expect(result.changed).toBe(true);
    expect(await readFile(settings, "utf8")).toBe(first);
    expect(await backups()).toHaveLength(0);
  });

  test("invalid JSON exits nonzero without touching the file", async () => {
    const invalid = "{ synthetic invalid JSON\n";
    await writeFile(settings, invalid);
    const proc = Bun.spawn([process.execPath, join(process.cwd(), "scripts/install-claude-hooks.ts"), "--settings", settings], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).not.toBe(0);
    expect(await readFile(settings, "utf8")).toBe(invalid);
    expect(await backups()).toHaveLength(0);
  });
});

describe("OMP extension installer", () => {
  test("install copies the extension into a new target directory", async () => {
    const target = join(scratch, "nested", "extensions");
    await installOmp(ompArgs(["--target", target]));
    expect(await readFile(join(target, "dash.ts"), "utf8")).toBe(await readFile(join(process.cwd(), "omp-extension/dash.ts"), "utf8"));
  });

  test("uninstall removes only dash.ts", async () => {
    const target = join(scratch, "extensions");
    await mkdir(target);
    await writeFile(join(target, "unrelated.ts"), "synthetic unrelated extension\n");
    await installOmp(ompArgs(["--target", target]));
    await installOmp(ompArgs(["--target", target, "--uninstall"]));
    expect(await readdir(target)).toEqual(["unrelated.ts"]);
  });

  test("dry-run creates no target directory", async () => {
    const target = join(scratch, "dry-run-extension");
    await installOmp(ompArgs(["--target", target, "--dry-run"]));
    expect((await readdir(scratch)).includes("dry-run-extension")).toBe(false);
  });
});

#!/usr/bin/env bun
import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const LABEL = "com.dash.liveness-push";
const URL_RE = /^https:\/\/[A-Za-z0-9._:[\]%-]+(?::\d+)?(?:\/[^\s'"`]*)?$/;

export type Args = {
  url: string;
  host: string;
  claudeBin: string;
  interval: number;
  plist: string;
  dryRun: boolean;
  uninstall: boolean;
};

function defaultClaudeBin(): string {
  const found = spawnSync("zsh", ["-lc", "whence -p claude"], { encoding: "utf8" });
  // Login shells can print banners first; the resolved path is the last line.
  const path = found.status === 0 ? found.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "" : "";
  return path.startsWith("/") ? path : join(homedir(), ".local/bin/claude");
}

export function parseArgs(argv: string[]): Args {
  const result: Args = {
    url: "",
    host: hostname().split(".")[0] || "localhost",
    claudeBin: "",
    interval: 30,
    plist: join(homedir(), "Library/LaunchAgents/com.dash.liveness-push.plist"),
    dryRun: false,
    uninstall: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") result.dryRun = true;
    else if (flag === "--uninstall") result.uninstall = true;
    else if (["--url", "--host", "--claude-bin", "--interval", "--plist"].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--url") result.url = value;
      else if (flag === "--host") result.host = value;
      else if (flag === "--claude-bin") result.claudeBin = value;
      else if (flag === "--interval") {
        if (!/^\d+$/.test(value)) throw new Error("--interval must be an integer from 10 to 600");
        result.interval = Number(value);
      } else result.plist = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!result.uninstall && !result.claudeBin) result.claudeBin = defaultClaudeBin();
  validateArgs(result);
  return result;
}

function validateArgs(args: Args): void {
  if ((!args.uninstall || args.url) && !URL_RE.test(args.url)) throw new Error("--url must be an https URL without shell-sensitive characters");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.host)) throw new Error("--host must be a label of 1 to 64 letters, digits, underscores, or hyphens");
  if ((!args.uninstall || args.claudeBin) && !args.claudeBin.startsWith("/")) throw new Error("--claude-bin must be an absolute path");
  if (!Number.isInteger(args.interval) || args.interval < 10 || args.interval > 600) throw new Error("--interval must be an integer from 10 to 600");
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function buildScript(args: Pick<Args, "claudeBin" | "host" | "url">): string {
  return `out=$(${shellQuote(args.claudeBin)} agents --json 2>/dev/null) && [ -n "$out" ] && printf '%s' "$out" | /usr/bin/curl -s -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' -H 'X-Dash-Host: ${args.host}' --data-binary @- ${shellQuote(args.url)}`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function xmlString(value: string): string { return `<string>${xmlEscape(value)}</string>`; }

export function buildPlist(args: Pick<Args, "claudeBin" | "host" | "url" | "interval">): string {
  const script = buildScript(args);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>${xmlString(LABEL)}\n  <key>RunAtLoad</key><true/>\n  <key>StartInterval</key><integer>${args.interval}</integer>\n  <key>WorkingDirectory</key>${xmlString("/")}\n  <key>ProcessType</key>${xmlString("Background")}\n  <key>StandardOutPath</key>${xmlString("/dev/null")}\n  <key>StandardErrorPath</key>${xmlString("/dev/null")}\n  <key>ProgramArguments</key>\n  <array>${xmlString("/bin/sh")}${xmlString("-c")}${xmlString(script)}\n  </array>\n</dict>\n</plist>\n`;
}

export type Exec = (command: string, args: string[]) => Promise<void>;
const execCommand: Exec = async (command, args) => {
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
};

function launchctlCommands(args: Args, uid = typeof process.getuid === "function" ? process.getuid() : 0): string[] {
  return args.uninstall
    ? [`launchctl bootout gui/${uid}/${LABEL} (errors ignored)`, `rm ${shellQuote(args.plist)}`]
    : [`launchctl bootout gui/${uid}/${LABEL} (errors ignored)`, `launchctl bootstrap gui/${uid} ${shellQuote(args.plist)}`];
}

export async function install(args: Args, exec: Exec = execCommand): Promise<string> {
  validateArgs(args);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (args.dryRun) {
    return `${args.uninstall ? "Would uninstall" : "Would install"} ${args.plist}\n${launchctlCommands(args, uid).join("\n")}${args.uninstall ? "" : `\n${buildPlist(args)}`}`;
  }
  if (args.uninstall) {
    await exec("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {});
    await rm(args.plist, { force: true });
    return `Uninstalled ${args.plist}`;
  }
  await mkdir(dirname(args.plist), { recursive: true });
  await writeFile(args.plist, buildPlist(args), { encoding: "utf8", mode: 0o644 });
  await exec("launchctl", ["bootout", `gui/${uid}/${LABEL}`]).catch(() => {});
  await exec("launchctl", ["bootstrap", `gui/${uid}`, args.plist]);
  return `Installed ${args.plist}`;
}

if (import.meta.main) {
  try { console.log(await install(parseArgs(Bun.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

#!/usr/bin/env bun
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Args = { target: string; uninstall: boolean; dryRun: boolean };
export function parseArgs(argv: string[]): Args {
  const result: Args = { target: join(homedir(), ".omp", "agent", "extensions"), uninstall: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--uninstall") result.uninstall = true;
    else if (argv[i] === "--dry-run") result.dryRun = true;
    else if (argv[i] === "--target") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--target requires a directory");
      result.target = value;
    } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return result;
}

export async function install(args: Args): Promise<string> {
  const targetDir = resolve(args.target);
  const destination = join(targetDir, "dash.ts");
  const cacheDestination = join(targetDir, "fence-cache.ts");
  const source = join(import.meta.dir, "..", "omp-extension", "dash.ts");
  const cacheSource = join(import.meta.dir, "..", "omp-extension", "fence-cache.ts");
  if (args.dryRun) return `${args.uninstall ? "Would remove" : "Would copy"} ${destination} and ${cacheDestination}`;
  if (args.uninstall) {
    await rm(destination, { force: true });
    await rm(cacheDestination, { force: true });
    return `Removed ${destination} and ${cacheDestination}`;
  }
  await stat(source);
  await stat(cacheSource);
  await mkdir(targetDir, { recursive: true });
  await copyFile(cacheSource, cacheDestination);
  await copyFile(source, destination);
  return `Installed ${destination} and ${cacheDestination}`;
}

if (import.meta.main) {
  try { console.log(await install(parseArgs(Bun.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

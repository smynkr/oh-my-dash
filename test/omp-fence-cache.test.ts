import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFenceCache, writeFenceCache } from "../omp-extension/fence-cache.ts";

const directories: string[] = [];
function privateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dash-omp-fence-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("persistent OMP autopilot fence cache", () => {
  test("restores the active goal after extension restart and ages it by the monotonic seed", () => {
    const directory = privateDirectory();
    writeFenceCache("host", "session", { goalId: 7, expiresAt: 99_000, remainingTtlMs: 5_000 }, 10_000, directory);
    expect(readFenceCache("host", "session", 11_500, directory)).toEqual({ kind: "active", record: {
      goalId: 7, expiresAt: 99_000, remainingTtlMs: 3_500, seededMonotonicMs: 10_000,
    } });
    expect(readFenceCache("host", "session", 15_000, directory)).toEqual({ kind: "cold" });
  });
  test("persists a monotonic-reset denial until a successful hub refresh", () => {
    const directory = privateDirectory();
    writeFenceCache("host","session",{goalId:7,expiresAt:99_000,remainingTtlMs:5_000},10_000,directory);
    const rebooted = readFenceCache("host","session",100,directory);
    expect(rebooted).toMatchObject({kind:"active",record:{remainingTtlMs:5_000,seededMonotonicMs:Number.MAX_SAFE_INTEGER}});
    expect(readFenceCache("host","session",20_000,directory)).toMatchObject({kind:"active",record:{remainingTtlMs:5_000}});
    writeFenceCache("host","session",{goalId:7,expiresAt:99_000,remainingTtlMs:5_000},20_000,directory);
    expect(readFenceCache("host","session",24_000,directory)).toMatchObject({kind:"active",record:{remainingTtlMs:1_000,seededMonotonicMs:20_000}});
    expect(readFenceCache("host","session",25_000,directory)).toEqual({kind:"cold"});
  });

  test("bounds conservative metadata-free entries and isolates session identity", () => {
    const directory = privateDirectory();
    writeFenceCache("host", "session-a", { goalId: null, expiresAt: null, remainingTtlMs: 86_400_000 }, 1_000, directory);
    expect(readFenceCache("host", "session-a", 2_000, directory)).toMatchObject({ kind: "active", record: { remainingTtlMs: 86_399_000 } });
    expect(readFenceCache("host", "session-b", 2_000, directory)).toEqual({ kind: "cold" });
    expect(statSync(directory).mode & 0o077).toBe(0);
    const cacheFile = readdirSync(directory)[0]!;
    expect(statSync(join(directory, cacheFile)).mode & 0o077).toBe(0);
  });
});

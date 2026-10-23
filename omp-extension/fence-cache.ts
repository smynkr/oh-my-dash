import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_FENCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECORD_BYTES = 4096;
const HOST_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENOENT = "ENOENT";

export type FenceCacheRecord = {
  goalId: number | null;
  expiresAt: number | null;
  remainingTtlMs: number;
  seededMonotonicMs: number;
};
export type FenceCacheRead = { kind: "cold" } | { kind: "invalid" } | { kind: "active"; record: FenceCacheRecord };

export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function cacheDirectory(): string {
  return join(process.env.HOME || homedir(), ".omp", "cache", "dash-autopilot-fence");
}
function recordPath(host: string, sessionId: string, directory: string): string {
  if (!HOST_RE.test(host) || typeof sessionId !== "string" || !sessionId || Buffer.byteLength(sessionId, "utf8") > 1024)
    throw new TypeError("Invalid fence cache identity");
  const key = createHash("sha256").update(`${host}\0${sessionId}`).digest("hex");
  return join(directory, `${key}.json`);
}
function ownerUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (ownerUid() !== undefined && stat.uid !== ownerUid()))
    throw new Error("Fence cache directory is not a private user directory");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Fence cache directory permissions are not private");
}
function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  assertPrivateDirectory(directory);
}
function syncFenceDirectory(directory: string): void {
  if (process.platform === "win32") throw new Error("Durable OMP fence cache is unavailable on Windows");
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function validRecord(value: unknown): value is FenceCacheRecord & { version: 1; active: true } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "active,expiresAt,goalId,remainingTtlMs,seededMonotonicMs,version" ||
      record.version !== 1 || record.active !== true ||
      !Number.isSafeInteger(record.remainingTtlMs) || Number(record.remainingTtlMs) < 1 || Number(record.remainingTtlMs) > MAX_FENCE_TTL_MS ||
      !Number.isSafeInteger(record.seededMonotonicMs) || Number(record.seededMonotonicMs) < 0) return false;
  const fallback = record.goalId === null && record.expiresAt === null;
  const metadata = Number.isSafeInteger(record.goalId) && Number(record.goalId) > 0 &&
    Number.isSafeInteger(record.expiresAt) && Number(record.expiresAt) > 0;
  return fallback || metadata;
}

export function readFenceCache(
  host: string,
  sessionId: string,
  nowMonotonicMs = monotonicNowMs(),
  directory = cacheDirectory(),
): FenceCacheRead {
  let path: string;
  try { path = recordPath(host, sessionId, directory); }
  catch { return { kind: "invalid" }; }
  let info;
  try {
    assertPrivateDirectory(directory);
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === ENOENT) return { kind: "cold" };
    return { kind: "invalid" };
  }
  if (!info.isFile() || info.isSymbolicLink() || (ownerUid() !== undefined && info.uid !== ownerUid()) ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0) || info.size > MAX_RECORD_BYTES) return { kind: "invalid" };
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev ||
        (ownerUid() !== undefined && opened.uid !== ownerUid()) ||
        (process.platform !== "win32" && (opened.mode & 0o077) !== 0) || opened.size > MAX_RECORD_BYTES)
      return { kind: "invalid" };
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!validRecord(value)) return { kind: "invalid" };
    if (nowMonotonicMs < value.seededMonotonicMs) {
      if (value.seededMonotonicMs !== Number.MAX_SAFE_INTEGER) {
        try {
          writeFenceCache(host, sessionId, {
            goalId: value.goalId, expiresAt: value.expiresAt, remainingTtlMs: value.remainingTtlMs,
          }, Number.MAX_SAFE_INTEGER, directory);
        } catch { return { kind: "invalid" }; }
      }
      return { kind: "active", record: {
        goalId: value.goalId, expiresAt: value.expiresAt, remainingTtlMs: value.remainingTtlMs,
        seededMonotonicMs: Number.MAX_SAFE_INTEGER,
      } };
    }
    const elapsed = nowMonotonicMs - value.seededMonotonicMs;
    const remainingTtlMs = Math.max(0, value.remainingTtlMs - elapsed);
    if (remainingTtlMs === 0) {
      unlinkSync(path);
      return { kind: "cold" };
    }
    return { kind: "active", record: {
      goalId: value.goalId, expiresAt: value.expiresAt, remainingTtlMs, seededMonotonicMs: value.seededMonotonicMs,
    } };
  } catch {
    return { kind: "invalid" };
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

export function writeFenceCache(
  host: string,
  sessionId: string,
  record: Omit<FenceCacheRecord, "seededMonotonicMs">,
  nowMonotonicMs = monotonicNowMs(),
  directory = cacheDirectory(),
): void {
  const path = recordPath(host, sessionId, directory);
  const normalized: FenceCacheRecord & { version: 1; active: true } = {
    version: 1, active: true,
    goalId: record.goalId,
    expiresAt: record.expiresAt,
    remainingTtlMs: Math.min(record.remainingTtlMs, MAX_FENCE_TTL_MS),
    seededMonotonicMs: nowMonotonicMs,
  };
  if (!validRecord(normalized)) throw new TypeError("Invalid active fence cache record");
  ensureDirectory(directory);
  const temp = join(directory, `.${createHash("sha256").update(`${host}\0${sessionId}`).digest("hex")}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(normalized)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
    syncFenceDirectory(directory);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* Keep the original filesystem error. */ }
    throw error;
  }
}

export function clearFenceCache(host: string, sessionId: string, directory = cacheDirectory()): void {
  let path: string;
  try { path = recordPath(host, sessionId, directory); }
  catch { return; }
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== ENOENT) throw error; }
}

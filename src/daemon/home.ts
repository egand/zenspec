/**
 * The `~/.zenspec` directory (plan §5, §13): location, legacy v1 cleanup, and `daemon.json`.
 * Also imported by the CLI, so it depends on Node built-ins and core types only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DaemonInfo, HealthResponse } from "../core/api.js";
import { ROUTES } from "../core/api.js";

export function resolveHome(home?: string): string {
  return path.resolve(home ?? process.env.ZENSPEC_HOME ?? path.join(os.homedir(), ".zenspec"));
}

/** Expands a leading `~/` to the user's home directory. */
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** v1 kept `sessions/` and `state.json` here; v2 does not read them. */
export function removeLegacyState(home: string): void {
  fs.rmSync(path.join(home, "sessions"), { recursive: true, force: true });
  fs.rmSync(path.join(home, "state.json"), { force: true });
}

export const daemonFile = (home: string) => path.join(home, "daemon.json");

/** The recorded daemon, or null when absent or invalid. Shared by the CLI and the daemon. */
export function readDaemonInfo(home: string): DaemonInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(daemonFile(home), "utf8")) as DaemonInfo;
    return Number.isInteger(info.pid) && Number.isInteger(info.port) ? info : null;
  } catch {
    return null;
  }
}

export function writeDaemonInfo(home: string, info: DaemonInfo): void {
  writeFileAtomic(daemonFile(home), JSON.stringify(info) + "\n");
}

/** Removes `daemon.json` only if it still describes `pid` (a newer daemon may own it). */
export function clearDaemonInfo(home: string, pid: number): void {
  if (readDaemonInfo(home)?.pid === pid) fs.rmSync(daemonFile(home), { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The recorded daemon, if its process is alive and answers `/api/health` with the same pid
 * (a reused pid after a crash does not count).
 */
export async function liveDaemon(home: string): Promise<DaemonInfo | null> {
  const info = readDaemonInfo(home);
  if (!info || !pidAlive(info.pid)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${ROUTES.health}`, {
      signal: AbortSignal.timeout(1000),
    });
    const health = (await res.json()) as HealthResponse;
    return health.pid === info.pid ? info : null;
  } catch {
    return null;
  }
}

const lockFile = (home: string) => path.join(home, "daemon.lock");
/** A lock this young belongs to a daemon that may still be starting (no `daemon.json` yet). */
const LOCK_GRACE_MS = 10_000;

/**
 * Takes `daemon.lock`, so only one daemon runs per home even when several CLIs spawn one at
 * once. Returns the holder's pid when another daemon holds it (alive, and still starting or
 * answering `/api/health`); a stale lock is taken over.
 */
export async function acquireLock(home: string): Promise<number | null> {
  const lock = lockFile(home);
  const tmp = `${lock}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, String(process.pid));
  try {
    for (;;) {
      try {
        fs.linkSync(tmp, lock); // atomic: fails if the lock exists, never exposes a partial file
        return null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const holder = readLock(lock);
      if (holder && pidAlive(holder.pid)) {
        const fresh = Date.now() - holder.mtimeMs < LOCK_GRACE_MS;
        if (fresh || (await liveDaemon(home))?.pid === holder.pid) return holder.pid;
      }
      fs.rmSync(lock, { force: true });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Releases `daemon.lock` if this process holds it. */
export function releaseLock(home: string): void {
  if (readLock(lockFile(home))?.pid === process.pid) fs.rmSync(lockFile(home), { force: true });
}

function readLock(lock: string): { pid: number; mtimeMs: number } | null {
  try {
    return { pid: Number(fs.readFileSync(lock, "utf8")), mtimeMs: fs.statSync(lock).mtimeMs };
  } catch {
    return null;
  }
}

/** Write-to-temp then rename, so readers never see a partial file. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

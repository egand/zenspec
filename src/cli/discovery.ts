/**
 * Daemon discovery (plan §13): read `daemon.json`, check `/health`, and (re)start the daemon
 * when it is missing, dead, or running another version. The port always comes from the file.
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ROUTES, type DaemonInfo, type HealthResponse } from "../core/api.js";
import { type CliContext, zenspecHome } from "./context.js";
import { UnreachableError } from "./errors.js";
import { DaemonClient } from "./http.js";

const HEALTH_TIMEOUT_MS = 1000;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5000;
const POLL_MS = 50;

function daemonInfoPath(ctx: Pick<CliContext, "env">): string {
  return path.join(zenspecHome(ctx), "daemon.json");
}

export function readDaemonInfo(ctx: Pick<CliContext, "env">): DaemonInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(daemonInfoPath(ctx), "utf8")) as DaemonInfo;
    return Number.isInteger(info.port) ? info : undefined;
  } catch {
    return undefined;
  }
}

/** Health of the daemon on `port`, or undefined when nothing healthy answers. */
export async function probe(port: number): Promise<HealthResponse | undefined> {
  try {
    return await new DaemonClient(port).get<HealthResponse>(ROUTES.health, {
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
}

/** A client for a healthy daemon of this CLI's version, starting one if needed. */
export async function connect(ctx: CliContext): Promise<DaemonClient> {
  const info = readDaemonInfo(ctx);
  if (info) {
    const health = await probe(info.port);
    if (health?.version === ctx.version) return new DaemonClient(info.port);
    if (health) await stopDaemon(info.port, health.pid);
  }
  ctx.spawnDaemon();
  const port = await until(ctx.startTimeoutMs ?? START_TIMEOUT_MS, async () => {
    const next = readDaemonInfo(ctx);
    if (!next || next.version !== ctx.version) return undefined;
    return (await probe(next.port))?.version === ctx.version ? next.port : undefined;
  });
  if (port === undefined) throw new UnreachableError("daemon did not start");
  return new DaemonClient(port);
}

/** Ask the daemon to exit and wait until it stops answering; SIGTERM as a fallback. */
export async function stopDaemon(port: number, pid: number): Promise<void> {
  const gone = async () => ((await probe(port)) ? undefined : true);
  await new DaemonClient(port).post(ROUTES.stop).catch(() => undefined);
  if (await until(STOP_TIMEOUT_MS, gone)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  if (!(await until(STOP_TIMEOUT_MS, gone))) throw new UnreachableError("daemon did not stop");
}

/** Poll `check` until it yields a value or `timeoutMs` elapses. */
async function until<T>(timeoutMs: number, check: () => Promise<T | undefined>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined || Date.now() >= deadline) return value;
    await delay(POLL_MS);
  }
}

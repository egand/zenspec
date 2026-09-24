/**
 * The ZenSpec daemon (plan §13): one global `node:http` server on 127.0.0.1, the only
 * writer of `~/.zenspec`, stopped by request or after an idle period. It is never idle while
 * a plan is approved or implementing, so living-plan tracking (§10) keeps running.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { PAGES } from "../core/api.js";
import { loadConfig } from "./config.js";
import {
  acquireLock,
  clearDaemonInfo,
  readDaemonInfo,
  releaseLock,
  removeLegacyState,
  resolveHome,
  writeDaemonInfo,
} from "./home.js";
import { HttpError, sendError, sendJson, type Handler } from "./http.js";
import { KnowledgeBase } from "./kb.js";
import { Registry } from "./registry.js";
import { buildRouter } from "./routes.js";
import { defaultClientDir, serveFile, serveIndex } from "./static.js";

export interface DaemonOptions {
  /** Defaults to `$ZENSPEC_HOME`, then `~/.zenspec`. */
  home?: string;
  /** `0` picks a free port. Defaults to `config.yaml` `daemon.port`, then `0`. */
  port?: number;
  /** Idle shutdown delay. Defaults to `config.yaml` `daemon.idleMinutes` (30). */
  idleMs?: number;
  /** Defaults to the build's version. */
  version?: string;
  /** Built browser client. Defaults to `dist/client`. */
  clientDir?: string;
  /** Call `process.exit(0)` once stopped (for the foreground `daemon run` command). */
  exitProcess?: boolean;
}

export interface RunningDaemon {
  port: number;
  url: string;
  home: string;
  /** Stops the server, watchers and timers, and removes `daemon.json`. Idempotent. */
  stop: () => Promise<void>;
  /** Resolves once the daemon has stopped, whatever stopped it. */
  stopped: Promise<void>;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(
    readonly pid: number,
    /** Unknown while the other daemon is still starting. */
    readonly port?: number,
  ) {
    super(`A zenspec daemon is already running (pid ${pid}${port ? `, port ${port}` : ""})`);
  }
}

const DEFAULT_IDLE_MINUTES = 30;

function buildVersion(): string {
  return typeof __ZENSPEC_VERSION__ === "string" ? __ZENSPEC_VERSION__ : "0.0.0-dev";
}

export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const home = resolveHome(options.home);
  const version = options.version ?? buildVersion();
  fs.mkdirSync(home, { recursive: true });

  const holder = await acquireLock(home);
  if (holder !== null) throw new DaemonAlreadyRunningError(holder, readDaemonInfo(home)?.port);
  try {
    return await launch(home, version, options);
  } catch (err) {
    releaseLock(home);
    throw err;
  }
}

/** Starts the daemon; the caller holds `daemon.lock`. */
async function launch(
  home: string,
  version: string,
  options: DaemonOptions,
): Promise<RunningDaemon> {
  removeLegacyState(home);

  const config = loadConfig(home);
  const idleMs = options.idleMs ?? (config.daemon?.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
  const clientDir = options.clientDir ?? defaultClientDir();

  const kb = new KnowledgeBase(config.knowledgeBase);
  await kb.start();

  let idleTimer: NodeJS.Timeout | undefined;
  const registry = new Registry(home, { kb, onActivity: () => resetIdle() });
  const server = http.createServer();
  let port = 0;

  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      clearTimeout(idleTimer);
      clearDaemonInfo(home, process.pid);
      releaseLock(home);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([closed, registry.close(), kb.stop()]);
      resolveStopped();
      if (options.exitProcess) process.exit(0);
    })());

  function resetIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (!stopping && registry.activity() === 0 && !registry.hasLivingPlan()) {
      idleTimer = setTimeout(() => void stop(), idleMs);
    }
  }

  const router = buildRouter({
    registry,
    kb,
    pid: process.pid,
    version,
    startedAt: new Date().toISOString(),
    port: () => port,
    requestStop: () => void stop(),
  });

  server.on("request", (req, res) => {
    resetIdle();
    // Again once answered: the request may have approved a plan or finished one.
    res.once("close", resetIdle);
    void handle(req, res).catch((err: unknown) => sendError(res, err));
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = `http://127.0.0.1:${port}`;
    if (!allowedHost(req.headers.host, port))
      throw new HttpError("forbidden", "Invalid Host header");
    if (req.headers.origin && ![origin, `http://localhost:${port}`].includes(req.headers.origin)) {
      throw new HttpError("forbidden", "Cross-origin requests are not allowed");
    }
    if (req.headers.origin) res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const { handler, params } = router.match(req.method ?? "GET", url.pathname);
      const body = await (handler as Handler)({ req, res, params, query: url.searchParams });
      if (body !== undefined && !res.headersSent && !res.destroyed) sendJson(res, 200, body);
      return;
    }
    if (req.method !== "GET") throw new HttpError("not_found", `No route for ${url.pathname}`);
    if (isPage(url.pathname)) return serveIndex(res, clientDir);
    if (!serveFile(res, clientDir, decodeURIComponent(url.pathname.slice(1)))) {
      throw new HttpError("not_found", `Not found: ${url.pathname}`);
    }
  }

  await registry.loadLivingPlans();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? config.daemon?.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  writeDaemonInfo(home, { pid: process.pid, port, version });
  resetIdle();

  return { port, url: `http://127.0.0.1:${port}`, home, stop, stopped };
}

function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

const PAGE_PATTERNS = Object.values(PAGES).map(
  (template) => new RegExp(`^${template.replace(/:\w+/g, "[^/]+")}/?$`),
);

function isPage(pathname: string): boolean {
  return pathname === "/" || PAGE_PATTERNS.some((re) => re.test(pathname));
}

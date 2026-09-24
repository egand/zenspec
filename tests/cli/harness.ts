/** Test harness: a stub daemon implementing `api.ts` routes, plus a captured `CliContext`. */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";
import type { HealthResponse, OpenDocResponse, PublishResponse } from "../../src/core/api.js";
import type { ReviewPayload } from "../../src/core/payload.js";
import type { CliContext } from "../../src/cli/context.js";
import { runCli } from "../../src/cli/main.js";

export interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

/** A JSON reply, or `"drop"` to destroy the connection without answering. */
export type StubReply = { status?: number; body?: unknown } | "drop";
export type StubHandler = (req: StubRequest) => StubReply | Promise<StubReply>;

export interface Stub {
  port: number;
  calls: StubRequest[];
  /** Calls to one `METHOD /path` route. */
  callsTo(route: string): StubRequest[];
  close(): Promise<void>;
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Routes are keyed `"METHOD /path"`; `GET /api/health` is built in. */
export async function startStub(
  routes: Record<string, StubHandler> = {},
  version = __ZENSPEC_VERSION__,
): Promise<Stub> {
  const calls: StubRequest[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://stub");
    const call = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: raw ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    const reply: StubReply =
      call.path === "/api/health" && !handler
        ? { body: health(stub.port, version) }
        : handler
          ? await handler(call)
          : { status: 404, body: { error: { code: "not_found", message: "no route" } } };
    if (reply === "drop") return req.socket.destroy();
    res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stub: Stub = {
    port: (server.address() as AddressInfo).port,
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  cleanups.push(() => server.listening && stub.close());
  return stub;
}

function health(port: number, version: string): HealthResponse {
  return { pid: process.pid, port, version, startedAt: "2026-01-01T00:00:00.000Z" };
}

/** A temp `ZENSPEC_HOME` and repo directory, removed after the test. */
export function tempDirs(): { home: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenspec-cli-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(repo, "docs", "plans"), { recursive: true });
  return { home, repo };
}

export function writeDaemonJson(home: string, port: number, version = __ZENSPEC_VERSION__) {
  fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: 1, port, version }));
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
  opened: string[];
  spawned: number;
}

export interface RunOptions {
  home: string;
  cwd: string;
  stdin?: string;
  spawnDaemon?: () => void;
}

/** Run the real CLI dispatch in-process with captured I/O. */
export async function run(argv: string[], options: RunOptions): Promise<Run> {
  const out: Run = { code: -1, stdout: "", stderr: "", opened: [], spawned: 0 };
  const ctx: CliContext = {
    cwd: options.cwd,
    env: { ZENSPEC_HOME: options.home },
    stdin: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
    stdout: { write: (s: string) => (out.stdout += s) },
    stderr: { write: (s: string) => (out.stderr += s) },
    version: __ZENSPEC_VERSION__,
    spawnDaemon: () => {
      out.spawned++;
      options.spawnDaemon?.();
    },
    openUrl: async (url) => void out.opened.push(url),
    startTimeoutMs: 200,
  };
  out.code = await runCli(argv, ctx);
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures for a document at `<repo>/docs/plans/plan.md`
// ---------------------------------------------------------------------------

export const DOC = "/api/docs/r1/d1";

export function writePlan(repo: string): string {
  const file = path.join(repo, "docs", "plans", "plan.md");
  fs.writeFileSync(file, "# Plan\n\n- [ ] Step\n");
  return file;
}

export function openDocReply(repo: string, viewed = false): OpenDocResponse {
  return {
    doc: {
      repoId: "r1",
      docId: "d1",
      repoRoot: repo,
      relPath: "docs/plans/plan.md",
      kind: "markdown",
      phase: "in_review",
    },
    url: "http://127.0.0.1/d/r1/d1",
    created: !viewed,
    viewed,
  };
}

export const PUBLISHED: PublishResponse = {
  revision: { n: 2, contentHash: "h", summary: "", author: "agent", ts: "2026-01-01T00:00:00Z" },
  created: true,
  lastReview: 4,
};

export const PAYLOAD: ReviewPayload = {
  verdict: "changes_requested",
  review: 5,
  revision: 2,
  threads: [{ id: "t1", kind: "comment", at: "L3", quote: "Step", body: "Which step?" }],
  next: "zenspec review docs/plans/plan.md -r <id>:<edited|answered|declined>[:note]",
};

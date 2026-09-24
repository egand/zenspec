/** In-process daemon fixtures: a temp `ZENSPEC_HOME`, temp git repos, and a tiny API client. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import type {
  DocStateResponse,
  OpenDocResponse,
  PublishRequest,
  PublishResponse,
  SubmitReviewRequest,
  SubmitReviewResponse,
  WaitReviewResponse,
} from "../../src/core/api.js";
import { ROUTES, fillPath } from "../../src/core/api.js";
import { createMarkdownAnchor } from "../../src/core/anchor.js";
import { parseDocument } from "../../src/core/parse.js";
import type { MarkdownAnchor } from "../../src/core/types.js";
import { startDaemon, type DaemonOptions, type RunningDaemon } from "../../src/daemon/index.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `zenspec-${prefix}-`)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A git repo with `files` written into it. Returns its root. */
export function tempRepo(files: Record<string, string> = {}, name = "repo"): string {
  const root = path.join(tempDir("repo"), name);
  fs.mkdirSync(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
  return root;
}

export function writeFile(root: string, rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export interface Reply<T = any> {
  status: number;
  body: T;
}

export class Api {
  constructor(readonly base: string) {}

  async call<T = any>(method: string, route: string, body?: unknown): Promise<Reply<T>> {
    const res = await fetch(this.base + route, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.includes("json") ? JSON.parse(text) : text };
  }

  async ok<T = any>(method: string, route: string, body?: unknown): Promise<T> {
    const reply = await this.call<T>(method, route, body);
    if (reply.status !== 200) {
      throw new Error(`${method} ${route} → ${reply.status} ${JSON.stringify(reply.body)}`);
    }
    return reply.body;
  }
}

/** A document handle bound to one registered file. */
export class Doc {
  constructor(
    readonly api: Api,
    readonly file: string,
    readonly repoId: string,
    readonly docId: string,
  ) {}

  route(template: string, extra: Record<string, string | number> = {}): string {
    return fillPath(template, { repoId: this.repoId, docId: this.docId, ...extra });
  }

  write(content: string): void {
    fs.writeFileSync(this.file, content);
  }

  publish(req: PublishRequest = {}): Promise<PublishResponse> {
    return this.api.ok("POST", this.route(ROUTES.revisions), req);
  }

  /** Waits for the first review after `after`, or after the delivered cursor when omitted. */
  wait(after?: number, timeoutMs?: number): Promise<WaitReviewResponse> {
    const query = new URLSearchParams();
    if (after !== undefined) query.set("after", String(after));
    if (timeoutMs !== undefined) query.set("timeoutMs", String(timeoutMs));
    return this.api.ok("GET", `${this.route(ROUTES.nextReview)}?${query}`);
  }

  async submit(req: Partial<SubmitReviewRequest> & { revision: number }) {
    const body: SubmitReviewRequest = {
      verdict: "changes_requested",
      summary: "",
      opened: [],
      reopened: [],
      replies: [],
      resolved: [],
      ...req,
    };
    return (await this.api.ok<SubmitReviewResponse>("POST", this.route(ROUTES.reviews), body))
      .review;
  }

  state(): Promise<DocStateResponse> {
    return this.api.ok("GET", this.route(ROUTES.doc));
  }

  /** A text anchor on the first occurrence of `quote` in `text` (captured at `revision`). */
  anchor(text: string, quote: string, revision: number): MarkdownAnchor {
    const start = text.indexOf(quote);
    if (start < 0) throw new Error(`Quote not found: ${quote}`);
    const snap = { kind: "markdown" as const, revision, text, blocks: parseDocument(text).blocks };
    return createMarkdownAnchor(snap, { start, end: start + quote.length });
  }
}

export interface TestDaemon {
  daemon: RunningDaemon;
  api: Api;
  home: string;
  open: (file: string) => Promise<Doc>;
}

/** Starts a daemon on port 0; stopped after the test. Reuse `home` to simulate a restart. */
export async function startTestDaemon(options: DaemonOptions = {}): Promise<TestDaemon> {
  const home = options.home ?? tempDir("home");
  const daemon = await startDaemon({ port: 0, idleMs: 60_000, ...options, home });
  cleanups.push(() => daemon.stop());
  const api = new Api(daemon.url);
  const open = async (file: string) => {
    const { doc } = await api.ok<OpenDocResponse>("POST", ROUTES.docs, { path: file });
    return new Doc(api, file, doc.repoId, doc.docId);
  };
  return { daemon, api, home, open };
}

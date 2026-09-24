/**
 * One reviewed document in memory: `replay(events)` plus the draft, with every mutation
 * appended to its log first (plan §5, §8.1, §9, §10). Mutations are synchronous, so a
 * request's appends never interleave with another's.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import type {
  CloseRequest,
  DocStateResponse,
  PublishRequest,
  PublishResponse,
  SseMessage,
  SubmitReviewRequest,
  ThreadActionRequest,
} from "../core/api.js";
import { SSE_EVENTS } from "../core/api.js";
import { reanchorDraft, reanchorThreads, type Snapshot } from "../core/anchor.js";
import { diffHunks } from "../core/diff.js";
import { EVENT_SCHEMA_VERSION, type UnstampedEvent, type ZenEvent } from "../core/events.js";
import { classifyChange, parseDocument } from "../core/parse.js";
import { latestReview, latestRevision, reduce, replay, threadList } from "../core/reducer.js";
import type {
  Author,
  DocState,
  Document,
  DocumentRef,
  Draft,
  Response,
  Review,
  Revision,
  ThreadId,
} from "../core/types.js";
import { badRequest, conflict, notFound } from "./http.js";
import { absolutePath } from "./identity.js";
import type { KnowledgeBase } from "./kb.js";
import type { DocStorage } from "./storage.js";

export type WaitOutcome =
  | { kind: "review"; review: Review }
  | { kind: "closed"; by: Author; reason: string }
  | { kind: "timeout" };

interface Waiter {
  after: number;
  settle: (outcome: WaitOutcome) => void;
}

export type Listener = (message: SseMessage) => void;

export interface SessionContext {
  kb: KnowledgeBase;
  /** Called when the number of waiters or SSE listeners changes (idle shutdown, §13). */
  onActivity: () => void;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** What anchors are re-anchored against. HTML needs a DOM, so the daemon skips it. */
export function snapshotOf(ref: DocumentRef, content: string, revision: number): Snapshot | null {
  if (ref.kind !== "markdown") return null;
  return { kind: "markdown", revision, text: content, blocks: parseDocument(content).blocks };
}

export class DocSession {
  readonly file: string;
  private events: ZenEvent[];
  private current: DocState;
  private draftValue: Draft | null;
  /** Last content seen on disk: the baseline for living-plan change classification (§10). */
  private disk: string | null;
  private readonly listeners = new Set<Listener>();
  private readonly waiters = new Set<Waiter>();

  constructor(
    readonly ref: DocumentRef,
    readonly storage: DocStorage,
    private readonly ctx: SessionContext,
  ) {
    this.file = absolutePath(ref);
    this.events = storage.readEvents();
    this.current = replay(this.events);
    this.draftValue = storage.readDraft();
    this.disk = this.readDiskOrNull();
  }

  get state(): DocState {
    return this.current;
  }

  get draft(): Draft | null {
    return this.draftValue;
  }

  get document(): Document {
    return { ...this.ref, phase: this.current.phase };
  }

  /** Waiters plus SSE listeners. */
  get activity(): number {
    return this.waiters.size + this.listeners.size;
  }

  get viewed(): boolean {
    return this.listeners.size > 0;
  }

  get updatedAt(): string | undefined {
    return this.events.at(-1)?.ts;
  }

  readDisk(): string {
    const content = this.readDiskOrNull();
    if (content === null) throw notFound(`File not found: ${this.file}`);
    return content;
  }

  private readDiskOrNull(): string | null {
    try {
      return fs.readFileSync(this.file, "utf8");
    } catch {
      return null;
    }
  }

  snapshot(): DocStateResponse {
    const content = this.readDiskOrNull() ?? "";
    return {
      doc: this.ref,
      events: this.events,
      content,
      contentHash: hashContent(content),
      draft: this.draftValue,
    };
  }

  // -------------------------------------------------------------------------
  // Log
  // -------------------------------------------------------------------------

  private append(event: UnstampedEvent): ZenEvent {
    const stamped = {
      ...event,
      schemaVersion: EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
    } as ZenEvent;
    this.storage.appendEvent(stamped);
    this.events.push(stamped);
    this.current = reduce(this.current, stamped);
    this.broadcast({ event: SSE_EVENTS.event, data: stamped });
    return stamped;
  }

  private broadcast(message: SseMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.ctx.onActivity();
    return () => {
      if (this.listeners.delete(listener)) this.ctx.onActivity();
    };
  }

  // -------------------------------------------------------------------------
  // Agent: publish (§8.1)
  // -------------------------------------------------------------------------

  publish(req: PublishRequest): PublishResponse {
    const author = req.author ?? "agent";
    this.checkResponses(req.responses ?? []);
    const content = this.readDisk();
    const contentHash = hashContent(content);
    const last = latestRevision(this.current);
    let created = false;

    if (last?.contentHash !== contentHash) {
      const n = (last?.n ?? 0) + 1;
      const snap = snapshotOf(this.ref, content, n);
      const placements = snap ? reanchorThreads(threadList(this.current), snap) : {};
      this.storage.writeRevision(n, content);
      this.append({
        type: "revision_published",
        author,
        n,
        contentHash,
        summary: req.summary ?? "",
        ...(Object.keys(placements).length > 0 && { placements }),
      });
      if (this.draftValue) {
        const threads = snap
          ? reanchorDraft(this.draftValue.threads, snap)
          : this.draftValue.threads;
        this.setDraft({ ...this.draftValue, revision: n, threads });
      }
      created = true;
    }

    const revision = latestRevision(this.current) as Revision;
    if (req.responses?.length) {
      this.append({
        type: "agent_responded",
        author,
        revision: revision.n,
        responses: req.responses,
      });
    }
    return { revision, created, lastReview: latestReview(this.current)?.n ?? 0 };
  }

  private checkResponses(responses: Response[]): void {
    for (const r of responses) {
      if (!this.current.threads[r.thread]) throw badRequest(`Unknown thread: ${r.thread}`);
    }
  }

  // -------------------------------------------------------------------------
  // Reviewer: submit, draft, thread actions (§9)
  // -------------------------------------------------------------------------

  submit(req: SubmitReviewRequest, author: Author = "reviewer"): Review {
    if (this.current.closed) throw conflict("The review session is closed");
    const last = latestRevision(this.current);
    if (!last) throw conflict("Nothing has been published yet");
    if (req.revision !== last.n) {
      throw conflict(`Review targets revision ${req.revision}, but the latest is ${last.n}`);
    }
    for (const id of [...req.reopened.map((r) => r.id), ...req.resolved]) {
      if (!this.current.threads[id]) throw badRequest(`Unknown thread: ${id}`);
    }

    const first = this.current.threadOrder.length + 1;
    const opened = req.opened.map((thread, i) => ({ ...thread, id: `t${first + i}` }));
    this.append({
      type: "review_submitted",
      author,
      n: (latestReview(this.current)?.n ?? 0) + 1,
      revision: req.revision,
      verdict: req.verdict,
      summary: req.summary,
      opened,
      reopened: req.reopened,
      resolved: req.resolved,
    });
    this.setDraft(null);
    this.answerFromKnowledgeBase(opened.map((t) => t.id));
    this.settleWaiters();
    return latestReview(this.current) as Review;
  }

  /** §11: explain threads whose term already has a note are answered by the daemon. */
  private answerFromKnowledgeBase(ids: ThreadId[]): void {
    const responses: Response[] = [];
    for (const id of ids) {
      const thread = this.current.threads[id];
      if (thread?.kind !== "explain") continue;
      const note = this.ctx.kb.lookup(thread.term);
      if (note) {
        responses.push({
          thread: id,
          action: "answered",
          note: `${note.title}: ${note.url ?? note.path}`,
        });
      }
    }
    if (responses.length === 0) return;
    const revision = latestRevision(this.current)?.n ?? 0;
    this.append({ type: "agent_responded", author: "daemon", revision, responses });
  }

  setDraft(draft: Draft | null): void {
    this.draftValue = draft && { ...draft, updatedAt: new Date().toISOString() };
    this.storage.writeDraft(this.draftValue);
    this.broadcast({ event: SSE_EVENTS.draft, data: { draft: this.draftValue } });
  }

  /** Stages resolve/reopen in the draft; only `review_submitted` changes thread status. */
  stageThreadAction(id: ThreadId, action: ThreadActionRequest): Draft {
    if (!this.current.threads[id]) throw notFound(`Unknown thread: ${id}`);
    const draft = this.draftValue ?? this.emptyDraft();
    const reopen = draft.reopen.filter((r) => r.thread !== id);
    const resolve = draft.resolve.filter((t) => t !== id);
    if (action.action === "resolve") resolve.push(id);
    if (action.action === "reopen") {
      reopen.push({ thread: id, body: action.body, attachments: action.attachments ?? [] });
    }
    this.setDraft({ ...draft, reopen, resolve });
    return this.draftValue as Draft;
  }

  private emptyDraft(): Draft {
    return {
      revision: latestRevision(this.current)?.n ?? 0,
      summary: "",
      threads: [],
      reopen: [],
      resolve: [],
      updatedAt: new Date().toISOString(),
    };
  }

  close(req: CloseRequest): void {
    if (this.current.closed) throw conflict("The review session is already closed");
    const by = req.by ?? "agent";
    this.append({ type: "session_closed", author: by, by, reason: req.reason ?? "" });
    this.settleWaiters();
  }

  // -------------------------------------------------------------------------
  // Waiting (§8.1): broadcast, nothing is drained
  // -------------------------------------------------------------------------

  /** Resolves with the first review numbered above `after`, the session closing, or a timeout. */
  wait(after: number, timeoutMs?: number, signal?: AbortSignal): Promise<WaitOutcome> {
    const ready = this.outcomeFor(after);
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        after,
        settle: (outcome) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (this.waiters.delete(waiter)) this.ctx.onActivity();
          resolve(outcome);
        },
      };
      const onAbort = () => waiter.settle({ kind: "timeout" });
      if (timeoutMs !== undefined) timer = setTimeout(onAbort, timeoutMs);
      signal?.addEventListener("abort", onAbort);
      this.waiters.add(waiter);
      this.ctx.onActivity();
    });
  }

  private outcomeFor(after: number): WaitOutcome | null {
    const review = this.current.reviews.find((r) => r.n > after);
    if (review) return { kind: "review", review };
    const closed = this.current.closed;
    return closed ? { kind: "closed", by: closed.by, reason: closed.reason } : null;
  }

  private settleWaiters(): void {
    for (const waiter of [...this.waiters]) {
      const outcome = this.outcomeFor(waiter.after);
      if (outcome) waiter.settle(outcome);
    }
  }

  /** Ends every pending wait (daemon shutdown). */
  abortWaiters(): void {
    for (const waiter of [...this.waiters]) waiter.settle({ kind: "timeout" });
  }

  // -------------------------------------------------------------------------
  // Disk changes: live preview (§9) and living plans (§10)
  // -------------------------------------------------------------------------

  onDiskChange(): void {
    const content = this.readDiskOrNull();
    if (content === null || content === this.disk) return;
    const before = this.disk;
    this.disk = content;
    this.broadcast({
      event: SSE_EVENTS.content,
      data: { content, contentHash: hashContent(content) },
    });
    const { phase } = this.current;
    if (before === null || this.ref.kind !== "markdown") return;
    if (phase !== "approved" && phase !== "implementing") return;

    const change = classifyChange(before, content);
    if (change.kind === "checkbox-only") {
      for (const { step, checked } of change.steps) {
        this.append({ type: "step_checked", author: "agent", step, checked });
      }
    } else if (change.kind === "content") {
      this.append({
        type: "plan_drifted",
        author: "agent",
        revision: latestRevision(this.current)?.n ?? 0,
        diffSummary: diffSummary(before, content),
      });
    }
  }
}

/** E.g. `+3 -1 lines at L12, L40`. */
export function diffSummary(before: string, after: string): string {
  const hunks = diffHunks(before, after, 0);
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.op === "insert") added++;
      if (line.op === "delete") removed++;
    }
  }
  const at = hunks.map((h) => `L${h.newStart}`).join(", ");
  return `+${added} -${removed} lines${at ? ` at ${at}` : ""}`;
}

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
  Presence,
  PublishRequest,
  PublishResponse,
  SseMessage,
  SubmitReviewRequest,
} from "../core/api.js";
import { SSE_EVENTS } from "../core/api.js";
import { reanchorDraft, reanchorThreads, type Snapshot } from "../core/anchor.js";
import { diffHunks } from "../core/diff.js";
import { EVENT_SCHEMA_VERSION, type UnstampedEvent, type ZenEvent } from "../core/events.js";
import { classifyChange, parseDocument } from "../core/parse.js";
import { analyze } from "../core/parse/document.js";
import {
  latestReview,
  latestRevision,
  pendingDrift,
  reduce,
  replay,
  threadList,
} from "../core/reducer.js";
import type {
  AttachmentRef,
  Author,
  DocState,
  Document,
  DocumentRef,
  Draft,
  Phase,
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
  /** Number of the last review delivered to the agent (persisted in `delivered.json`). */
  private deliveredReview: number;
  private readonly listeners = new Set<Listener>();
  private readonly waiters = new Set<Waiter>();
  /** Last agent activity seen by this daemon process (see `Presence`). */
  private agentSeenAt: string | undefined;

  constructor(
    readonly ref: DocumentRef,
    readonly storage: DocStorage,
    private readonly ctx: SessionContext,
  ) {
    this.file = absolutePath(ref);
    this.events = storage.readEvents();
    this.current = replay(this.events);
    const draft = storage.readDraft();
    // Drafts saved before replies existed lack the field.
    this.draftValue = draft && { ...draft, replies: draft.replies ?? [] };
    this.agentSeenAt = this.events.findLast((e) => isAgent(e.author))?.ts;
    this.deliveredReview = storage.readDelivered();
    this.disk = this.readDiskOrNull();
    this.catchUpOffline();
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

  get delivered(): number {
    return this.deliveredReview;
  }

  /** Records that review `n` reached the agent; the cursor never moves back. */
  markDelivered(n: number): void {
    if (n <= this.deliveredReview) return;
    this.deliveredReview = n;
    this.storage.writeDelivered(n);
  }

  /** Approved or implementing: disk edits are tracked as steps and drift (§10). */
  get living(): boolean {
    return isLiving(this.current.phase);
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
      presence: this.presence,
    };
  }

  get presence(): Presence {
    return {
      waiting: this.waiters.size,
      ...(this.agentSeenAt && { agentSeenAt: this.agentSeenAt }),
    };
  }

  private agentActive(): void {
    this.agentSeenAt = new Date().toISOString();
    this.broadcast({ event: SSE_EVENTS.presence, data: this.presence });
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
    if (isAgent(stamped.author)) this.agentActive();
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

    // Running `review` again reopens a closed session; a new revision has already done so.
    if (this.current.closed) this.append({ type: "session_reopened", author });

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
    const touched = [...req.reopened.map((r) => r.id), ...req.replies.map((r) => r.thread)];
    for (const id of [...touched, ...req.resolved]) {
      if (!this.current.threads[id]) throw badRequest(`Unknown thread: ${id}`);
    }

    const first = this.current.threadOrder.length + 1;
    const opened = req.opened.map((thread, i) => ({
      ...thread,
      id: `t${first + i}`,
      attachments: this.storedAttachments(thread.attachments),
    }));
    const reopened = req.reopened.map((r) => ({
      ...r,
      attachments: this.storedAttachments(r.attachments),
    }));
    const replies = req.replies.map((r) => ({
      ...r,
      attachments: this.storedAttachments(r.attachments ?? []),
    }));
    this.append({
      type: "review_submitted",
      author,
      n: (latestReview(this.current)?.n ?? 0) + 1,
      revision: req.revision,
      verdict: req.verdict,
      summary: req.summary,
      opened,
      reopened,
      ...(replies.length > 0 && { replies }),
      resolved: req.resolved,
    });
    this.setDraft(null);
    this.answerFromKnowledgeBase(opened.map((t) => t.id));
    this.settleWaiters();
    return latestReview(this.current) as Review;
  }

  /**
   * The stored attachments `refs` point to, described from the stored bytes (the client's
   * mime and size are not trusted). 400 for an id that is malformed or not in the store.
   */
  private storedAttachments(refs: AttachmentRef[]): AttachmentRef[] {
    return refs.map(({ id }) => {
      const stored = this.storage.readAttachmentRef(id);
      if (!stored) throw badRequest(`Unknown attachment: ${id}`);
      return stored;
    });
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

  /** §10: accepts every pending drift. Does not change the phase or wake waiters. */
  acceptDrift(author: Author = "reviewer"): void {
    if (this.current.closed) throw conflict("The review session is closed");
    if (!pendingDrift(this.current).length) throw conflict("There is no plan drift to accept");
    this.append({ type: "drift_accepted", author });
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

  /**
   * Resolves with the first review numbered above `after` (default: the last review delivered
   * to the agent), the session closing, or a timeout. Every waiter registered before a review
   * arrives receives it; the caller advances the cursor with `markDelivered` once it is sent.
   */
  wait(
    after = this.deliveredReview,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<WaitOutcome> {
    const ready = this.outcomeFor(after);
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        after,
        settle: (outcome) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (this.waiters.delete(waiter)) {
            this.ctx.onActivity();
            this.agentActive();
          }
          resolve(outcome);
        },
      };
      const onAbort = () => waiter.settle({ kind: "timeout" });
      if (timeoutMs !== undefined) timer = setTimeout(onAbort, timeoutMs);
      signal?.addEventListener("abort", onAbort);
      this.waiters.add(waiter);
      this.ctx.onActivity();
      this.agentActive();
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
    if (before === null || this.ref.kind !== "markdown" || !this.living) return;
    this.recordChange(before, content, true);
  }

  /**
   * §10: classifies edits made while no daemon watched the plan, against the latest revision
   * with the recorded step states applied. Drift already recorded for that revision is not
   * recorded again (the log cannot tell whether the file drifted further).
   */
  private catchUpOffline(): void {
    const baseline = this.livingBaseline();
    if (baseline === null || this.disk === null) return;
    const revision = latestRevision(this.current)?.n;
    const drifted = this.current.drift.some((d) => d.revision === revision);
    this.recordChange(baseline, this.disk, !drifted);
  }

  /** The latest revision of a living Markdown plan, with its checkboxes set as recorded. */
  private livingBaseline(): string | null {
    const revision = latestRevision(this.current);
    if (this.ref.kind !== "markdown" || !this.living || !revision) return null;
    let text = this.storage.readRevision(revision.n);
    if (text === null) return null;
    for (const [step, offset] of analyze(text).checkboxOffsets) {
      const state = this.current.steps[step];
      if (state)
        text = `${text.slice(0, offset)}${state.checked ? "x" : " "}${text.slice(offset + 1)}`;
    }
    return text;
  }

  private recordChange(before: string, after: string, drift: boolean): void {
    const change = classifyChange(before, after);
    if (change.kind === "checkbox-only") {
      for (const { step, checked } of change.steps) {
        this.append({ type: "step_checked", author: "agent", step, checked });
      }
    } else if (change.kind === "content" && drift) {
      this.append({
        type: "plan_drifted",
        author: "agent",
        revision: latestRevision(this.current)?.n ?? 0,
        diffSummary: diffSummary(before, after),
      });
    }
  }
}

export function isLiving(phase: Phase): boolean {
  return phase === "approved" || phase === "implementing";
}

/** Reviewer and daemon events are not agent activity; any other author is an agent. */
function isAgent(author: Author): boolean {
  return author !== "reviewer" && author !== "daemon";
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

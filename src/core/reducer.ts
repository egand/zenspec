/**
 * Event-sourced document state (plan §4, §5, §10). Pure: `replay(events)` always
 * yields the same state, and `reduce` never mutates its input.
 *
 * Deterministic rules for events that do not fit the model (they are no-ops):
 * - Events with an unknown `schemaVersion` or `type` are skipped.
 * - A revision whose `n` is not `last + 1` is skipped; so is a review whose `n` is
 *   not `last + 1` or whose `revision` has not been published.
 * - A thread transition not allowed by `nextStatus` leaves the thread untouched and
 *   appends no message (e.g. a response to a resolved thread, reopening an open one).
 * - Responses and actions on unknown thread ids, and re-opening an existing id, are skipped.
 * - Within one review, `opened` is applied first, then `reopened`, `replies`, and `resolved`.
 * - A reply appends a `reply` message to an unresolved thread and never changes its status;
 *   replies to resolved or unknown threads are skipped.
 * - `drift_accepted` marks every drift not yet accepted; it is skipped when there is none.
 * - After `session_closed`, only `revision_published` is applied, and it reopens the session.
 * - `step_checked` and `plan_drifted` before approval are skipped (§10: they only
 *   describe changes to an approved plan).
 *
 * Phases only move forward:
 * - `drafting`: before the first review (including after the first revision).
 * - `in_review`: the first non-approving review.
 * - `approved`: an approving review while drafting or in review.
 * - `implementing`: the first checked step after approval.
 * - `done`: an approving review while implementing (final sign-off).
 * Non-approving reviews after approval keep the phase, so the gate stays open (§10).
 */
import { EVENT_SCHEMA_VERSION } from "./events.js";
import type {
  AgentResponded,
  DriftAccepted,
  PlanDrifted,
  ReviewSubmitted,
  RevisionPublished,
  SessionClosed,
  StepChecked,
  ZenEvent,
} from "./events.js";
import type {
  DocState,
  Message,
  Phase,
  ResponseAction,
  Review,
  Drift,
  Revision,
  Thread,
  ThreadId,
  ThreadStatus,
} from "./types.js";

/** What can happen to a thread. `block_gone` is a strategy-6 placement (§7). */
export type ThreadTrigger = ResponseAction | "resolve" | "reopen" | "block_gone";

const RESPONDED = { edited: "addressed", answered: "addressed", declined: "declined" } as const;

/**
 * The §4 state machine. Beyond the diagram: the agent may amend its response
 * (addressed ⇄ declined), and the reviewer may resolve an open or outdated thread
 * directly (withdrawing it). `resolved` is terminal.
 */
const TRANSITIONS: Record<ThreadStatus, Partial<Record<ThreadTrigger, ThreadStatus>>> = {
  open: { ...RESPONDED, resolve: "resolved", block_gone: "outdated" },
  addressed: { ...RESPONDED, resolve: "resolved", reopen: "open" },
  declined: { ...RESPONDED, resolve: "resolved", reopen: "open" },
  outdated: { resolve: "resolved", reopen: "open" },
  resolved: {},
};

/** The status after `trigger`, or `undefined` when the transition is not allowed. */
export function nextStatus(status: ThreadStatus, trigger: ThreadTrigger): ThreadStatus | undefined {
  return TRANSITIONS[status][trigger];
}

export function initialState(): DocState {
  return {
    phase: "drafting",
    revisions: [],
    reviews: [],
    threads: {},
    threadOrder: [],
    steps: {},
    drift: [],
  };
}

export function replay(events: readonly ZenEvent[]): DocState {
  return events.reduce<DocState>((state, event) => reduce(state, event), initialState());
}

export function reduce(state: DocState | undefined, event: ZenEvent): DocState {
  const current = state ?? initialState();
  if ((event as { schemaVersion: unknown }).schemaVersion !== EVENT_SCHEMA_VERSION) return current;
  if (current.closed && event.type !== "revision_published") return current;
  switch (event.type) {
    case "revision_published":
      return onRevision(current, event);
    case "review_submitted":
      return onReview(current, event);
    case "agent_responded":
      return onResponded(current, event);
    case "step_checked":
      return onStepChecked(current, event);
    case "plan_drifted":
      return onPlanDrifted(current, event);
    case "drift_accepted":
      return onDriftAccepted(current, event);
    case "session_closed":
      return onSessionClosed(current, event);
    default:
      return current;
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onRevision(state: DocState, e: RevisionPublished): DocState {
  if (e.n !== (latestRevision(state)?.n ?? 0) + 1) return state;
  const revision: Revision = {
    n: e.n,
    contentHash: e.contentHash,
    summary: e.summary,
    author: e.author,
    ts: e.ts,
  };
  const threads = { ...state.threads };
  for (const [id, placement] of Object.entries(e.placements ?? {})) {
    const thread = threads[id];
    if (!thread || thread.status === "resolved") continue;
    const status =
      placement.strategy === 6
        ? (nextStatus(thread.status, "block_gone") ?? thread.status)
        : thread.status;
    threads[id] = { ...thread, placement, status };
  }
  const next: DocState = { ...state, revisions: [...state.revisions, revision], threads };
  delete next.closed;
  return next;
}

function onReview(state: DocState, e: ReviewSubmitted): DocState {
  const known = e.revision >= 1 && e.revision <= (latestRevision(state)?.n ?? 0);
  if (e.n !== (latestReview(state)?.n ?? 0) + 1 || !known) return state;

  const threads = { ...state.threads };
  const threadOrder = [...state.threadOrder];
  const review: Review = {
    n: e.n,
    revision: e.revision,
    verdict: e.verdict,
    summary: e.summary,
    author: e.author,
    ts: e.ts,
    opened: [],
    reopened: [],
    replied: [],
    resolved: [],
  };
  const message = (action: Message["action"], body: string, attachments: Message["attachments"]) =>
    ({ author: e.author, body, action, attachments, ts: e.ts, review: e.n }) satisfies Message;

  for (const { body, attachments, ...spec } of e.opened) {
    if (threads[spec.id]) continue;
    threads[spec.id] = {
      ...spec,
      status: "open",
      messages: [message("comment", body, attachments)],
      openedIn: e.n,
    } as Thread;
    threadOrder.push(spec.id);
    review.opened.push(spec.id);
  }
  for (const { id, body, attachments } of e.reopened) {
    if (transition(threads, id, "reopen", message("reopened", body, attachments))) {
      review.reopened.push(id);
    }
  }
  for (const { thread: id, body, attachments } of e.replies ?? []) {
    const thread = threads[id];
    if (!thread || thread.status === "resolved") continue;
    const reply = message("reply", body, attachments ?? []);
    threads[id] = { ...thread, messages: [...thread.messages, reply] };
    if (!review.replied.includes(id)) review.replied.push(id);
  }
  for (const id of e.resolved) {
    if (transition(threads, id, "resolve", message("resolved", "", []))) review.resolved.push(id);
  }

  return {
    ...state,
    phase: phaseAfterReview(state.phase, e.verdict === "approved"),
    reviews: [...state.reviews, review],
    threads,
    threadOrder,
  };
}

function onResponded(state: DocState, e: AgentResponded): DocState {
  const threads = { ...state.threads };
  for (const r of e.responses) {
    transition(threads, r.thread, r.action, {
      author: e.author,
      body: r.note ?? "",
      action: r.action,
      attachments: [],
      ts: e.ts,
      revision: e.revision,
    });
  }
  return { ...state, threads };
}

function onStepChecked(state: DocState, e: StepChecked): DocState {
  if (!isApprovedPhase(state.phase)) return state;
  const phase = state.phase === "approved" && e.checked ? "implementing" : state.phase;
  return { ...state, phase, steps: { ...state.steps, [e.step]: { checked: e.checked, ts: e.ts } } };
}

function onPlanDrifted(state: DocState, e: PlanDrifted): DocState {
  if (!isApprovedPhase(state.phase)) return state;
  return {
    ...state,
    drift: [...state.drift, { revision: e.revision, diffSummary: e.diffSummary, ts: e.ts }],
  };
}

function onDriftAccepted(state: DocState, e: DriftAccepted): DocState {
  if (!state.drift.some((d) => !d.acceptedAt)) return state;
  return {
    ...state,
    drift: state.drift.map((d) => (d.acceptedAt ? d : { ...d, acceptedAt: e.ts })),
  };
}

function onSessionClosed(state: DocState, e: SessionClosed): DocState {
  return { ...state, closed: { by: e.by, reason: e.reason, ts: e.ts } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Applies `trigger` to a thread in a (locally owned) threads map. Returns whether it applied. */
function transition(
  threads: Record<ThreadId, Thread>,
  id: ThreadId,
  trigger: ThreadTrigger,
  message: Message,
): boolean {
  const thread = threads[id];
  const status = thread && nextStatus(thread.status, trigger);
  if (!status) return false;
  threads[id] = { ...thread, status, messages: [...thread.messages, message] };
  return true;
}

function phaseAfterReview(phase: Phase, approved: boolean): Phase {
  if (!approved) return phase === "drafting" ? "in_review" : phase;
  if (phase === "drafting" || phase === "in_review") return "approved";
  if (phase === "implementing") return "done";
  return phase;
}

function isApprovedPhase(phase: Phase): boolean {
  return phase === "approved" || phase === "implementing" || phase === "done";
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function latestRevision(state: DocState): Revision | undefined {
  return state.revisions.at(-1);
}

export function latestReview(state: DocState): Review | undefined {
  return state.reviews.at(-1);
}

/** Threads in creation order. */
export function threadList(state: DocState): Thread[] {
  return state.threadOrder.map((id) => state.threads[id]);
}

export function openThreads(state: DocState): Thread[] {
  return threadList(state).filter((t) => t.status === "open");
}

/**
 * Drift the reviewer has not dealt with: not accepted and not followed by a review (§10).
 * What the drift banner shows.
 */
export function pendingDrift(state: DocState): Drift[] {
  const since = latestReview(state)?.ts ?? "";
  return state.drift.filter((d) => !d.acceptedAt && d.ts > since);
}

export interface NewThreadEntry {
  thread: Thread;
  /** True when the thread predates these reviews and was reopened in one of them. */
  reopened: boolean;
}

/**
 * Threads opened, reopened or replied to by reviews of revision `revision` or later that are
 * still open: "only what's new" for the agent payload (§8.3). Review order.
 */
export function threadsSince(state: DocState, revision: number): NewThreadEntry[] {
  const entries = new Map<ThreadId, boolean>();
  for (const review of state.reviews) {
    if (review.revision < revision) continue;
    for (const id of review.opened) if (!entries.has(id)) entries.set(id, false);
    for (const id of review.reopened) if (!entries.has(id)) entries.set(id, true);
    for (const id of review.replied) if (!entries.has(id)) entries.set(id, false);
  }
  return [...entries]
    .map(([id, reopened]) => ({ thread: state.threads[id], reopened }))
    .filter(({ thread }) => thread.status === "open");
}

export interface GateStatus {
  /** True once the document has been approved (§10: drift does not close the gate). */
  approved: boolean;
  phase: Phase;
  /** Revision of the latest approving review, if any. */
  approvedRevision?: number;
}

export function gateStatus(state: DocState): GateStatus {
  const approval = state.reviews.findLast((r) => r.verdict === "approved");
  return {
    approved: isApprovedPhase(state.phase),
    phase: state.phase,
    ...(approval && { approvedRevision: approval.revision }),
  };
}

/**
 * Agent payloads (plan §8.3, §10, §11) built from a session's reduced state, with line
 * numbers computed against the file on disk at delivery time.
 */
import { reanchor } from "../core/anchor.js";
import { buildPayload, buildPendingPayload, type ExplainTarget } from "../core/format-payload.js";
import type { ReviewPayload } from "../core/payload.js";
import type { Placement, Review, Thread, ThreadId } from "../core/types.js";
import type { KnowledgeBase } from "./kb.js";
import { snapshotOf, type DocSession } from "./session.js";

/** Open threads opened or reopened in `review`, plus every open thread when it approves. */
function deliveredThreads(session: DocSession, review: Review): Thread[] {
  const { threads, threadOrder } = session.state;
  const ids = new Set([...review.opened, ...review.reopened]);
  if (review.verdict === "approved") {
    for (const id of threadOrder) if (threads[id]?.status === "open") ids.add(id);
  }
  return [...ids].map((id) => threads[id]!).filter((t) => t?.status === "open");
}

function placementsOnDisk(session: DocSession, threads: Thread[]): Record<ThreadId, Placement> {
  const placements: Record<ThreadId, Placement> = {};
  let content: string;
  try {
    content = session.readDisk();
  } catch {
    return placements;
  }
  const snap = snapshotOf(session.ref, content, 0);
  if (!snap) return placements;
  for (const thread of threads) {
    if (thread.kind !== "general") placements[thread.id] = reanchor(thread.anchor, snap);
  }
  return placements;
}

export function reviewPayload(
  session: DocSession,
  review: Review,
  kb: KnowledgeBase,
): ReviewPayload {
  const threads = deliveredThreads(session, review);
  const explain: Record<ThreadId, ExplainTarget> = {};
  for (const thread of threads) {
    const target = thread.kind === "explain" ? kb.explainTarget(thread.term) : undefined;
    if (target) explain[thread.id] = target;
  }
  return buildPayload({
    review,
    threads,
    placements: placementsOnDisk(session, threads),
    docPath: session.ref.relPath,
    attachmentPath: (id) => session.storage.attachmentPath(id),
    explain,
    phase: session.state.phase,
  });
}

export function pendingPayload(session: DocSession, timeoutMs?: number): ReviewPayload {
  return buildPendingPayload(
    session.ref.relPath,
    timeoutMs ? formatDuration(timeoutMs) : undefined,
  );
}

/** `600000` → `10m`, `45000` → `45s`, `1500` → `1500ms`. */
export function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/**
 * Implementation-time threads (§10) opened or reopened in reviews after the latest approval
 * and after `cursor`, merged into one payload. Null when no review is new; `payload` is null
 * when the new reviews left no open thread (the cursor still advances to `lastReview`).
 */
export function implementationPayload(
  session: DocSession,
  cursor: number,
  kb: KnowledgeBase,
): { payload: ReviewPayload | null; lastReview: number } | null {
  const { phase, reviews } = session.state;
  if (phase !== "approved" && phase !== "implementing") return null;
  const approval = reviews.findLast((r) => r.verdict === "approved")?.n ?? 0;
  const fresh = reviews.filter((r) => r.n > Math.max(cursor, approval));
  const last = fresh.at(-1);
  if (!last) return null;
  const merged: Review = {
    ...last,
    opened: fresh.flatMap((r) => r.opened),
    reopened: fresh.flatMap((r) => r.reopened),
  };
  const payload = reviewPayload(session, merged, kb);
  return { payload: payload.threads?.length ? payload : null, lastReview: last.n };
}

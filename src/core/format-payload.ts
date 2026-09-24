/**
 * Agent payload (plan §8.3, §8.4): pure builders from reduced state to `ReviewPayload`, and
 * the compact YAML serializer printed by `zenspec review`.
 */
import { Document, type Scalar, type YAMLSeq } from "yaml";
import type {
  LineRef,
  PayloadImage,
  PayloadThread,
  PayloadVerdict,
  ReviewPayload,
} from "./payload.js";
import type {
  Anchor,
  AttachmentId,
  Author,
  AttachmentRef,
  Choice,
  Message,
  Phase,
  Placement,
  Review,
  Thread,
  ThreadId,
} from "./types.js";

export const QUOTE_MAX_CHARS = 120;

/** Where the agent writes the note for an `explain` thread (§11). Paths as shown to the agent. */
export interface ExplainTarget {
  saveTo: string;
  template?: string;
}

export interface PayloadInput {
  /** The review being delivered. Its `revision` is the reviewed revision. */
  review: Review;
  /**
   * Threads to deliver: opened, reopened or replied to in `review`, plus, for `approved`, threads still
   * open. Resolved threads are dropped defensively.
   */
  threads: Thread[];
  /** Placements against the file on disk at delivery time; `at` is omitted when missing. */
  placements: Partial<Record<ThreadId, Placement>>;
  /** Document path as the agent passes it to `zenspec review`. */
  docPath: string;
  /** Resolves an attachment to its absolute path under `~/.zenspec/.../attachments/`. */
  attachmentPath: (id: AttachmentId) => string;
  /** Knowledge-base targets for explain threads that have no note yet (§11). */
  explain?: Partial<Record<ThreadId, ExplainTarget>>;
  /** Document phase after the review; `done` means nothing is left to do (§10). */
  phase?: Phase;
}

export function buildPayload(input: PayloadInput): ReviewPayload {
  const { review } = input;
  const threads = input.threads
    .filter((t) => t.status !== "resolved")
    .map((t) => buildThread(t, input));
  return {
    verdict: review.verdict,
    review: review.n,
    revision: review.revision,
    ...(review.summary && { summary: review.summary }),
    ...(threads.length > 0 && { threads }),
    next: nextHint(review.verdict, input.docPath, threads.length > 0, input.phase),
  };
}

/** Returned when `--wait` expires before a review arrives (§8.4). */
export function buildPendingPayload(docPath: string, wait?: string): ReviewPayload {
  return {
    verdict: "pending",
    next: `${reviewCommand(docPath)}${wait ? ` --wait ${wait}` : ""}`,
  };
}

/** Returned when the session is closed instead of reviewed: nothing is left to do. */
export function buildClosedPayload(by: Author, reason?: string): ReviewPayload {
  return { verdict: "closed", by, ...(reason && { reason }), next: "none" };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

function buildThread(thread: Thread, input: PayloadInput): PayloadThread {
  const reopened = input.review.reopened.includes(thread.id);
  const replied = input.review.replied.includes(thread.id);
  const message = deliveredMessage(thread, reopened || replied);
  const body = message?.body || undefined;
  const at = lineRef(input.placements[thread.id]);
  const images = message?.attachments.map((a) => image(a, input.attachmentPath));
  const base = {
    id: thread.id,
    ...(reopened && { reopened: true as const }),
    ...(input.review.verdict === "approved" &&
      thread.status === "open" && {
        status: "open" as const,
      }),
  };
  const tail = images?.length ? { images } : {};

  switch (thread.kind) {
    case "comment": {
      const quote = truncateQuote(anchorQuote(thread.anchor));
      return compact({ ...base, kind: "comment", at, quote, body: body ?? "", ...tail });
    }
    case "suggestion":
      return compact({
        ...base,
        kind: "suggestion",
        at,
        old: thread.old,
        new: thread.new,
        body,
        ...tail,
      });
    case "decision":
      return compact({
        ...base,
        kind: "decision",
        question: thread.question,
        at,
        choice: choiceValue(thread.choice),
        body,
        ...tail,
      });
    case "explain": {
      const target = input.explain?.[thread.id];
      return compact({
        ...base,
        kind: "explain",
        term: thread.term,
        at,
        body,
        save_to: target?.saveTo,
        template: target?.template,
        ...tail,
      });
    }
    case "general":
      return compact({ ...base, kind: "general", body: body ?? "", ...tail });
  }
}

/**
 * The reviewer message this delivery is about: the latest reopen or reply when the review
 * reopened or replied to the thread, otherwise the opening comment. A reply reuses the
 * thread's entry (same keys, no `reopened`), so it costs no extra overhead.
 */
function deliveredMessage(thread: Thread, followUp: boolean): Message | undefined {
  if (!followUp) return thread.messages[0];
  return (
    thread.messages.findLast((m) => m.action === "reopened" || m.action === "reply") ??
    thread.messages[0]
  );
}

function anchorQuote(anchor: Anchor): string {
  return anchor.type === "markdown" ? anchor.quote : anchor.textQuote;
}

function choiceValue(choice: Choice): string | string[] | number {
  switch (choice.mode) {
    case "single":
      return choice.option;
    case "multi":
      return choice.options;
    case "rating":
      return choice.value;
    case "other":
      return "other";
  }
}

function image(ref: AttachmentRef, resolve: (id: AttachmentId) => string): PayloadImage {
  return { path: resolve(ref.id), width: ref.width, height: ref.height };
}

export function lineRef(placement: Placement | undefined): LineRef | undefined {
  if (!placement?.lines || placement.strategy === 6) return undefined;
  const [start, end] = placement.lines;
  return end > start ? `L${start}-${end}` : `L${start}`;
}

/** Collapses whitespace to one line and cuts to 120 characters (code points), ending in `…`. */
export function truncateQuote(quote: string): string | undefined {
  const flat = quote.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  const chars = [...flat];
  if (chars.length <= QUOTE_MAX_CHARS) return flat;
  return `${chars
    .slice(0, QUOTE_MAX_CHARS - 1)
    .join("")
    .trimEnd()}…`;
}

/** Drops `undefined` fields so the YAML never carries nulls or empty keys. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// `next:` hints
// ---------------------------------------------------------------------------

function nextHint(
  verdict: PayloadVerdict,
  docPath: string,
  hasThreads: boolean,
  phase: Phase | undefined,
): string {
  const cmd = reviewCommand(docPath);
  const respond = `${cmd} -r <id>:<edited|answered|declined>[:note]`;
  if (verdict !== "approved") return hasThreads ? respond : cmd;
  if (phase === "done") return "done; no further action";
  const steps = `implement, ticking each step's checkbox; then ${cmd} -m implemented`;
  return hasThreads ? `${steps} -r <id>:<action>[:note]` : steps;
}

function reviewCommand(docPath: string): string {
  return `zenspec review ${shellQuote(docPath)}`;
}

function shellQuote(arg: string): string {
  return /^[\w./~@%+=:,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/**
 * Compact YAML: `verdict` on the first line, plain UTF-8 (never HTML-escaped), quotes only
 * where YAML needs them, multi-line text as literal blocks, and images as
 * `- <path> # <width>x<height>`.
 */
export function formatPayloadYaml(payload: ReviewPayload): string {
  const { verdict, by, reason, review, revision, summary, threads, next } = payload;
  const plain = compact({
    verdict,
    by,
    reason: reason || undefined,
    review,
    revision,
    summary: summary || undefined,
    threads: threads?.length
      ? threads.map((t) => (t.images ? { ...t, images: t.images.map((i) => i.path) } : t))
      : undefined,
    next,
  });
  const doc = new Document(plain);
  threads?.forEach((t, i) => {
    const seq = doc.getIn(["threads", i, "images"], true) as YAMLSeq<Scalar> | undefined;
    t.images?.forEach((img, j) => {
      const item = seq?.items[j];
      if (item) item.comment = ` ${img.width}x${img.height}`;
    });
  });
  return doc.toString({ lineWidth: 0, blockQuote: "literal" });
}

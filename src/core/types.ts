/**
 * Domain model (plan §4). Pure data: no behavior, no I/O.
 *
 * Conventions:
 * - Timestamps are ISO-8601 strings (`new Date().toISOString()`).
 * - Line numbers are 1-based and inclusive: `[start, end]`.
 * - Revision and review numbers are 1-based and assigned by the daemon.
 */

import type { RootContent } from "mdast";

/** Who produced an event or message. Free-form names are allowed for a future team mode. */
export type Author = "agent" | "reviewer" | "daemon" | (string & {});

export type IsoTime = string;
export type LineRange = [start: number, end: number];

/** `<repo folder>-<short hash of git top-level path>`, e.g. `zenspec-3f9a1c` (§5). */
export type RepoId = string;
/** Slug of the repo-relative path, e.g. `docs-plans-x-md` (§5). Unique within a repo. */
export type DocId = string;
/** Assigned by the daemon at submit time: `t1`, `t2`, ... unique within a document. */
export type ThreadId = string;
/** Derived by the parser: heading-path slug + ordinal, e.g. `caching/p3` (§6). */
export type BlockId = string;
/** Title slug or explicit `{#id}` override, e.g. `db-engine` (§6). */
export type QuestionId = string;
/** Derived by the parser from task-list items (§10). */
export type StepId = string;
/**
 * First 12 lowercase hex characters of the sha256 of the stored (downscaled) image bytes (§9.2).
 * The file is content-addressed as `attachments/<id>.<ext>`.
 */
export type AttachmentId = string;

// ---------------------------------------------------------------------------
// Document, revisions, reviews
// ---------------------------------------------------------------------------

export type DocumentKind = "markdown" | "html";

/** `drafting → in_review → approved → implementing → done` (§4, §10). */
export type Phase = "drafting" | "in_review" | "approved" | "implementing" | "done";

/** Stable identity of a reviewed file. */
export interface DocumentRef {
  repoId: RepoId;
  docId: DocId;
  /** Absolute git top-level path, or the file's directory outside git. */
  repoRoot: string;
  /** Path relative to `repoRoot`, POSIX separators. */
  relPath: string;
  kind: DocumentKind;
}

export interface Document extends DocumentRef {
  phase: Phase;
}

/** An explicit snapshot published by the agent (not every file save). */
export interface Revision {
  n: number;
  contentHash: string;
  summary: string;
  author: Author;
  ts: IsoTime;
}

export type Verdict = "approved" | "changes_requested" | "comment";

/** One submission by the reviewer against a revision. */
export interface Review {
  n: number;
  revision: number;
  verdict: Verdict;
  summary: string;
  author: Author;
  ts: IsoTime;
  opened: ThreadId[];
  reopened: ThreadId[];
  /** Threads that received a reply without a status change. */
  replied: ThreadId[];
  resolved: ThreadId[];
}

// ---------------------------------------------------------------------------
// Anchors (§7 markdown, §12 html)
// ---------------------------------------------------------------------------

/** W3C-style text selector captured by the browser when a thread is created. */
export interface MarkdownAnchor {
  type: "markdown";
  /** Revision the selector was captured against. */
  rev: number;
  block: BlockId;
  /** Selected text. Empty string anchors the whole block. */
  quote: string;
  /** ~32 characters before `quote`. */
  prefix: string;
  /** ~32 characters after `quote`. */
  suffix: string;
  /** Lines at `rev`. */
  lines: LineRange;
}

/** Element selector for HTML mockups (§12). */
export interface HtmlAnchor {
  type: "html";
  rev: number;
  cssPath: string;
  tag: string;
  textQuote: string;
}

export type Anchor = MarkdownAnchor | HtmlAnchor;

/**
 * Re-anchoring outcome (§7), numbered after the strategy that matched:
 * 1 context, 2 quote in block, 3 unique quote, 4 fuzzy, 5 whole block, 6 gone (outdated).
 * HTML anchors use 2 (text quote among same-tag elements), 3 (css path) and 6.
 */
export type AnchorStrategy = 1 | 2 | 3 | 4 | 5 | 6;

/** Where an anchor landed in a given revision. Cached per revision by the daemon. */
export interface Placement {
  revision: number;
  strategy: AnchorStrategy;
  /** Absent when `strategy` is 6. */
  block?: BlockId;
  lines?: LineRange;
  /** Text matched in this revision (differs from the original quote for strategies 4 and 5). */
  matched?: string;
  /** Similarity for strategy 4, in [0, 1]. */
  score?: number;
  /** HTML anchors: CSS path of the element the anchor landed on (strategies 2 and 3). */
  cssPath?: string;
}

// ---------------------------------------------------------------------------
// Threads and messages
// ---------------------------------------------------------------------------

export type ThreadKind = "comment" | "suggestion" | "decision" | "explain" | "general";
export type ThreadStatus = "open" | "addressed" | "declined" | "resolved" | "outdated";

/** Image attached to a message. The daemon resolves the id to a file path. */
export interface AttachmentRef {
  id: AttachmentId;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
}

/** A reviewer's answer to a `[!QUESTION]` block (§9.1). `other` carries its text in the body. */
export type Choice =
  | { mode: "single"; option: string }
  | { mode: "multi"; options: string[] }
  | { mode: "rating"; value: number }
  | { mode: "other" };

/** Kind-specific fields of a thread, fixed at creation. */
export type ThreadSpec =
  | { kind: "comment"; anchor: Anchor }
  | { kind: "suggestion"; anchor: MarkdownAnchor; old: string; new: string }
  | { kind: "decision"; anchor: MarkdownAnchor; question: QuestionId; choice: Choice }
  | { kind: "explain"; anchor: Anchor; term: string }
  | { kind: "general" };

/** A thread as created in a review (`review_submitted.opened[]`). */
export type NewThread = ThreadSpec & {
  id: ThreadId;
  body: string;
  attachments: AttachmentRef[];
};

export type ResponseAction = "edited" | "answered" | "declined";

/**
 * What a message did to its thread. `comment` is the opening message; `reply` is a reviewer
 * message on a thread that stays in its status.
 */
export type MessageAction = "comment" | "reopened" | "reply" | "resolved" | ResponseAction;

export interface Message {
  author: Author;
  body: string;
  action: MessageAction;
  attachments: AttachmentRef[];
  ts: IsoTime;
  /** Review number (reviewer messages) or revision number (agent messages) it belongs to. */
  review?: number;
  revision?: number;
}

/** Reduced thread state. */
export type Thread = ThreadSpec & {
  id: ThreadId;
  status: ThreadStatus;
  /** Chronological; the first message is the opening comment. */
  messages: Message[];
  /** Review that opened it. */
  openedIn: number;
  /** Latest known placement, if the thread is anchored. */
  placement?: Placement;
};

/** Agent response to one thread, recorded with `zenspec review -r <thread>:<action>[:<note>]`. */
export interface Response {
  thread: ThreadId;
  action: ResponseAction;
  note?: string;
}

// ---------------------------------------------------------------------------
// Parsed document (§6): one AST, many consumers
// ---------------------------------------------------------------------------

export interface Block {
  id: BlockId;
  /** mdast node type, e.g. `paragraph`, `heading`, `code`, `list`, `math`, `blockquote`. */
  type: string;
  lines: LineRange;
  /** Raw source text of the block. */
  source: string;
}

export type QuestionMode = "single" | "multi" | "rating";

export interface Question {
  id: QuestionId;
  mode: QuestionMode;
  title: string;
  block: BlockId;
  lines: LineRange;
  options: string[];
  recommended?: string;
}

/** A GFM task-list item used as a living-plan step (§10). */
export interface Step {
  id: StepId;
  text: string;
  checked: boolean;
  line: number;
  /** Heading path of the section containing the step. */
  section: string[];
}

export interface ParsedDocument {
  frontmatter?: Record<string, unknown>;
  blocks: Block[];
  questions: Question[];
  steps: Step[];
}

/** A block plus its mdast node, so the client can render it without reparsing. */
export interface ParsedBlock extends Block {
  node: RootContent;
}

/** What `parseDocument` returns: a `ParsedDocument` whose blocks carry their mdast nodes. */
export interface ParsedMarkdown extends ParsedDocument {
  blocks: ParsedBlock[];
}

export interface StepToggle {
  step: StepId;
  checked: boolean;
}

/**
 * How a document changed between two versions (§10):
 * `checkbox-only` means only plan-step checkboxes flipped (progress, `step_checked`);
 * `content` means anything else changed (drift after approval, `plan_drifted`).
 */
export type DocumentChange =
  { kind: "none" } | { kind: "checkbox-only"; steps: StepToggle[] } | { kind: "content" };

// ---------------------------------------------------------------------------
// Draft: the reviewer's pending review, stored server-side (§9, §9.1)
// ---------------------------------------------------------------------------

/** A thread not yet submitted. `id` is client-generated and replaced by a ThreadId on submit. */
export type DraftThread = ThreadSpec & {
  draftId: string;
  body: string;
  attachments: AttachmentRef[];
  /** Set when re-anchoring against the current content failed (§9.1). */
  orphaned?: boolean;
  placement?: Placement;
};

export interface DraftReopen {
  thread: ThreadId;
  body: string;
  attachments: AttachmentRef[];
}

/** A staged reply to an unresolved thread that does not change its status. */
export type DraftReply = DraftReopen;

export interface Draft {
  /** Revision the draft was last re-anchored against. */
  revision: number;
  verdict?: Verdict;
  summary: string;
  threads: DraftThread[];
  reopen: DraftReopen[];
  replies: DraftReply[];
  resolve: ThreadId[];
  updatedAt: IsoTime;
}

// ---------------------------------------------------------------------------
// Reduced document state: output of the shared reducer (§5)
// ---------------------------------------------------------------------------

export interface StepProgress {
  checked: boolean;
  ts: IsoTime;
}

export interface Drift {
  revision: number;
  diffSummary: string;
  ts: IsoTime;
  /** Set by `drift_accepted`: the reviewer accepted the change (§10). */
  acceptedAt?: IsoTime;
}

export interface DocState {
  phase: Phase;
  revisions: Revision[];
  reviews: Review[];
  /** Keyed by id; iterate in creation order via `threadOrder`. */
  threads: Record<ThreadId, Thread>;
  threadOrder: ThreadId[];
  steps: Record<StepId, StepProgress>;
  drift: Drift[];
  closed?: { by: Author; reason: string; ts: IsoTime };
}

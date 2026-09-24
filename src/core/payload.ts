/**
 * Agent payload (plan §8.3): the YAML printed on stdout by `zenspec review`.
 * Types only; the formatter lives elsewhere in core.
 *
 * Serialization rules the formatter must honor:
 * - Key order follows the declaration order below; `verdict` is always the first line.
 * - Text is plain UTF-8, never HTML-escaped.
 * - Quotes are truncated to 120 characters.
 * - Line numbers (`at`) refer to the file on disk at delivery time.
 * - Never includes the document, history, or resolved threads.
 */
import type { Author, QuestionId, ThreadId, Verdict } from "./types.js";

/**
 * `pending` is returned when `--wait` expires before a review arrives (§8.4); `closed` when
 * the review session is closed instead of reviewed.
 */
export type PayloadVerdict = Verdict | "pending" | "closed";

/** `L42` or `L42-44`. */
export type LineRef = `L${number}` | `L${number}-${number}`;

/** Rendered as `- <path>  # <width>x<height>`. */
export interface PayloadImage {
  /** Absolute path under `~/.zenspec/.../attachments/`. */
  path: string;
  width: number;
  height: number;
}

interface PayloadThreadBase {
  id: ThreadId;
  /** Present only when the reviewer reopened the thread in this review. */
  reopened?: true;
  /** Present only in approved payloads, for threads still open (§8.3). */
  status?: "open";
  images?: PayloadImage[];
}

export interface PayloadComment extends PayloadThreadBase {
  kind: "comment";
  at?: LineRef;
  quote?: string;
  body: string;
}

export interface PayloadSuggestion extends PayloadThreadBase {
  kind: "suggestion";
  at?: LineRef;
  old: string;
  new: string;
  body?: string;
}

/** `choice`: option label (single), labels (multi), number (rating), or `other` with the write-in in `body`. */
export interface PayloadDecision extends PayloadThreadBase {
  kind: "decision";
  question: QuestionId;
  at?: LineRef;
  choice: string | string[] | number;
  body?: string;
}

/** `save_to`/`template` are present only when a knowledge base is configured and no note exists (§11). */
export interface PayloadExplain extends PayloadThreadBase {
  kind: "explain";
  term: string;
  at?: LineRef;
  body?: string;
  save_to?: string;
  template?: string;
}

export interface PayloadGeneral extends PayloadThreadBase {
  kind: "general";
  body: string;
}

export type PayloadThread =
  PayloadComment | PayloadSuggestion | PayloadDecision | PayloadExplain | PayloadGeneral;

export interface ReviewPayload {
  verdict: PayloadVerdict;
  /** Who closed the session; present only when `verdict` is `closed`. */
  by?: Author;
  /** Why the session was closed; present only when `verdict` is `closed` and a reason was given. */
  reason?: string;
  /** Absent when `verdict` is `pending` or `closed`. */
  review?: number;
  revision?: number;
  summary?: string;
  threads?: PayloadThread[];
  /** The exact command the agent should run next. */
  next: string;
}

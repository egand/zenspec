/**
 * Daemon HTTP API (plan §7.2, §13). The CLI and the browser talk to the daemon only through this.
 *
 * - JSON in and out unless noted; errors use `ApiError` with a non-2xx status.
 * - The daemon binds to 127.0.0.1; CORS is limited to its own origin.
 * - A document is addressed by `:repoId/:docId`. The CLI obtains both from `POST /api/docs`.
 */
import type { ZenEvent } from "./events.js";
import type { ReviewPayload } from "./payload.js";
import type {
  AttachmentRef,
  Author,
  Document,
  DocumentRef,
  Draft,
  IsoTime,
  NewThread,
  Response,
  Review,
  Revision,
  ThreadId,
  Verdict,
} from "./types.js";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Path templates. `:name` segments are URL-encoded parameters. */
export const ROUTES = {
  health: "/api/health", // GET
  stop: "/api/daemon/stop", // POST
  docs: "/api/docs", // POST register/open
  doc: "/api/docs/:repoId/:docId", // GET state
  revisions: "/api/docs/:repoId/:docId/revisions", // POST publish
  revision: "/api/docs/:repoId/:docId/revisions/:n", // GET snapshot (text/markdown or text/html)
  nextReview: "/api/docs/:repoId/:docId/reviews/next", // GET long-poll, query WaitReviewQuery
  reviews: "/api/docs/:repoId/:docId/reviews", // POST submit
  draft: "/api/docs/:repoId/:docId/draft", // GET, PUT
  thread: "/api/docs/:repoId/:docId/threads/:threadId", // POST ThreadActionRequest
  attachments: "/api/docs/:repoId/:docId/attachments", // POST raw image bytes
  attachment: "/api/docs/:repoId/:docId/attachments/:attachmentId", // GET image
  close: "/api/docs/:repoId/:docId/close", // POST
  events: "/api/docs/:repoId/:docId/events", // GET text/event-stream
  inbox: "/api/inbox", // GET, query InboxQuery
  inboxPending: "/api/inbox/pending", // POST, marks returned threads delivered
  gate: "/api/gate", // GET, query GateQuery
  kbLookup: "/api/kb/lookup", // GET, query KbLookupQuery
  kbTerms: "/api/kb/terms", // GET
} as const;

/** Browser pages served by the daemon. */
export const PAGES = {
  doc: "/d/:repoId/:docId",
  inbox: "/inbox",
} as const;

export type RouteName = keyof typeof ROUTES;

/** Fill `:name` segments of a route or page template. */
export function fillPath(template: string, params: Record<string, string | number>): string {
  return template.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path parameter: ${name}`);
    return encodeURIComponent(String(value));
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "bad_request" // 400
  | "not_found" // 404: unknown document, revision, thread, or attachment
  | "conflict" // 409: e.g. submitting against a stale revision, or a closed session
  | "too_large" // 413
  | "internal"; // 500

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

/** Also the content of `~/.zenspec/daemon.json`. A version mismatch makes the CLI restart the daemon. */
export interface DaemonInfo {
  pid: number;
  port: number;
  version: string;
}

export interface HealthResponse extends DaemonInfo {
  startedAt: IsoTime;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** Register a file, or return the existing registration. Idempotent. */
export interface OpenDocRequest {
  /** Absolute path of the reviewed file. */
  path: string;
}

export interface OpenDocResponse {
  doc: Document;
  /** Absolute browser URL of the document page. */
  url: string;
  /** False when the document was already registered. */
  created: boolean;
  /** True when at least one browser tab is connected to the document's SSE stream. */
  viewed: boolean;
}

/**
 * Everything the browser needs to derive state with the shared reducer.
 * `content` is the file on disk now, which may be ahead of the last revision.
 */
export interface DocStateResponse {
  doc: DocumentRef;
  events: ZenEvent[];
  content: string;
  contentHash: string;
  draft: Draft | null;
}

/**
 * Publish the file's current content (read from disk by the daemon) as a revision
 * if it differs from the last one, then record responses.
 */
export interface PublishRequest {
  summary?: string;
  responses?: Response[];
  author?: Author;
}

export interface PublishResponse {
  /** The latest revision after this call (new or unchanged). */
  revision: Revision;
  created: boolean;
  /** Number of the latest review so far; pass as `after` to wait for the next one. */
  lastReview: number;
}

// ---------------------------------------------------------------------------
// Waiting for a review (long-poll, broadcast)
// ---------------------------------------------------------------------------

/**
 * Resolves with the first review numbered greater than `after`. Every waiter receives the
 * same review; nothing is drained. Without `timeoutMs` the request waits indefinitely.
 */
export interface WaitReviewQuery {
  after: number;
  timeoutMs?: number;
}

export type WaitReviewResponse =
  | { status: "delivered"; payload: ReviewPayload }
  | { status: "pending"; payload: ReviewPayload }
  | { status: "closed"; by: Author; reason: string };

// ---------------------------------------------------------------------------
// Reviewer actions
// ---------------------------------------------------------------------------

/** Full replacement of the server-side draft. */
export type SaveDraftRequest = Draft;
export interface DraftResponse {
  draft: Draft | null;
}

/**
 * Submit the pending review. The daemon assigns thread ids to `opened`, appends
 * `review_submitted`, clears the draft, and wakes every waiter.
 */
export interface SubmitReviewRequest {
  revision: number;
  verdict: Verdict;
  summary: string;
  opened: Omit<NewThread, "id">[];
  reopened: { id: ThreadId; body: string; attachments: AttachmentRef[] }[];
  resolved: ThreadId[];
}

export interface SubmitReviewResponse {
  review: Review;
}

/**
 * Resolve or reopen a thread. The action is staged in the draft and takes effect when
 * the review is submitted, because only `review_submitted` changes reviewer-owned status.
 */
export type ThreadActionRequest =
  | { action: "resolve" }
  | { action: "reopen"; body: string; attachments?: AttachmentRef[] }
  | { action: "unstage" };

export type ThreadActionResponse = DraftResponse;

/**
 * Body: raw image bytes with an `image/*` Content-Type. The daemon downscales to at most
 * 1568 px on the long edge and stores it content-addressed.
 */
export type UploadAttachmentResponse = AttachmentRef;

export interface CloseRequest {
  reason?: string;
  by?: Author;
}

// ---------------------------------------------------------------------------
// Inbox and gate
// ---------------------------------------------------------------------------

export interface InboxQuery {
  /** Limit to one repo (absolute path inside it). */
  repo?: string;
}

export interface InboxItem {
  doc: Document;
  url: string;
  lastRevision: number;
  lastReview: number;
  lastVerdict?: Verdict;
  openThreads: number;
  updatedAt: IsoTime;
}

export interface InboxResponse {
  items: InboxItem[];
}

/**
 * Implementation-time comments (§10) not yet delivered to the agent, for the
 * `PostToolUse` hook. Returned threads are marked delivered. Empty when nothing is new.
 */
export interface InboxPendingRequest {
  repo: string;
}

export interface InboxPendingResponse {
  items: { doc: DocumentRef; payload: ReviewPayload }[];
}

/** Either a single file, or every document in the repo containing `repo` (§14). */
export type GateQuery = { path: string } | { repo: string };

export interface GateResponse {
  /** True when every matched document is approved (or later). */
  approved: boolean;
  blocking: { doc: DocumentRef; phase: Document["phase"] }[];
}

// ---------------------------------------------------------------------------
// Knowledge base (§11)
// ---------------------------------------------------------------------------

export interface KbNote {
  slug: string;
  title: string;
  aliases: string[];
  summary?: string;
  /** Absolute file path. */
  path: string;
  /** From `knowledgeBase.link`, when configured. */
  url?: string;
}

export interface KbLookupQuery {
  term: string;
}

export interface KbLookupResponse {
  /** False when no knowledge base is configured. */
  configured: boolean;
  note: KbNote | null;
}

/** Index used for term tooltips in the browser. */
export interface KbTermsResponse {
  notes: KbNote[];
}

// ---------------------------------------------------------------------------
// Server-sent events (one stream per document)
// ---------------------------------------------------------------------------

export const SSE_EVENTS = {
  /** A `ZenEvent` was appended. Data: `ZenEvent`. */
  event: "zen-event",
  /** The file changed on disk (unpublished changes). Data: `SseContent`. */
  content: "content",
  /** The draft changed (another tab). Data: `DraftResponse`. */
  draft: "draft",
} as const;

export type SseEventName = (typeof SSE_EVENTS)[keyof typeof SSE_EVENTS];

export interface SseContent {
  content: string;
  contentHash: string;
}

export type SseMessage =
  | { event: typeof SSE_EVENTS.event; data: ZenEvent }
  | { event: typeof SSE_EVENTS.content; data: SseContent }
  | { event: typeof SSE_EVENTS.draft; data: DraftResponse };

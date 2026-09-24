/**
 * Event log (plan §5). One event per line in `events.jsonl`, append-only.
 * The daemon is the only writer; state is derived by a pure reducer in core,
 * shared by the daemon and the browser.
 */
import type {
  Author,
  AttachmentRef,
  IsoTime,
  NewThread,
  Placement,
  Response,
  StepId,
  ThreadId,
  Verdict,
} from "./types.js";

/** Bumped on any breaking change to the event shapes below. */
export const EVENT_SCHEMA_VERSION = 1;

interface EventBase {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  ts: IsoTime;
  author: Author;
}

export interface RevisionPublished extends EventBase {
  type: "revision_published";
  n: number;
  contentHash: string;
  summary: string;
  /**
   * Re-anchoring results for every thread that was not resolved, computed by the
   * daemon against this revision (§7 "cached per revision"). Recording them here
   * keeps the reducer pure: a strategy-6 placement moves an open thread to `outdated`.
   */
  placements?: Record<ThreadId, Placement>;
}

export interface ReviewSubmitted extends EventBase {
  type: "review_submitted";
  n: number;
  revision: number;
  verdict: Verdict;
  summary: string;
  opened: NewThread[];
  reopened: { id: ThreadId; body: string; attachments: AttachmentRef[] }[];
  resolved: ThreadId[];
}

export interface AgentResponded extends EventBase {
  type: "agent_responded";
  revision: number;
  responses: Response[];
}

/** Living plans (§10): a checkbox changed and nothing else did. */
export interface StepChecked extends EventBase {
  type: "step_checked";
  step: StepId;
  checked: boolean;
}

/** Living plans (§10): content changed after approval. */
export interface PlanDrifted extends EventBase {
  type: "plan_drifted";
  revision: number;
  diffSummary: string;
}

export interface SessionClosed extends EventBase {
  type: "session_closed";
  by: Author;
  reason: string;
}

export type ZenEvent =
  RevisionPublished | ReviewSubmitted | AgentResponded | StepChecked | PlanDrifted | SessionClosed;

export type ZenEventType = ZenEvent["type"];

/** An event before the daemon stamps it with `schemaVersion` and `ts`. */
export type UnstampedEvent = Unstamped<ZenEvent>;
type Unstamped<E> = E extends ZenEvent ? Omit<E, "schemaVersion" | "ts"> : never;

/** Test doubles for the browser store: an in-memory daemon API and a scriptable EventSource. */
import { vi } from "vitest";
import type { DocStateResponse, SubmitReviewRequest } from "../../../src/core/api.js";
import {
  EVENT_SCHEMA_VERSION,
  type ReviewSubmitted,
  type RevisionPublished,
} from "../../../src/core/events.js";
import type { Draft, NewThread } from "../../../src/core/types.js";
import type { Api } from "../../../src/client/store/api.js";
import { createDocStore } from "../../../src/client/store/doc-store.js";

let clock = 0;
const stamp = (author: string) => ({
  schemaVersion: EVENT_SCHEMA_VERSION as typeof EVENT_SCHEMA_VERSION,
  ts: new Date(Date.UTC(2026, 8, 24, 0, 0, clock++)).toISOString(),
  author,
});

export const revisionEvent = (n: number, contentHash = `hash-${n}`): RevisionPublished => ({
  ...stamp("agent"),
  type: "revision_published",
  n,
  contentHash,
  summary: `rev ${n}`,
});

export const reviewEvent = (
  n: number,
  revision: number,
  opened: NewThread[] = [],
  verdict: ReviewSubmitted["verdict"] = "changes_requested",
): ReviewSubmitted => ({
  ...stamp("reviewer"),
  type: "review_submitted",
  n,
  revision,
  verdict,
  summary: "",
  opened,
  reopened: [],
  resolved: [],
});

export const DOC_TEXT = [
  "# Plan",
  "",
  "We cache sessions in Redis with a TTL.",
  "",
  "> [!QUESTION] Which database?",
  "> - PostgreSQL (Recommended)",
  "> - SQLite",
  "",
  "> [!QUESTION] Which queue?",
  "> - Kafka",
  "> - SQS",
  "",
].join("\n");

export function fakeApi(initial: Partial<DocStateResponse> = {}) {
  const state: DocStateResponse = {
    doc: {
      repoId: "repo-1",
      docId: "plan-md",
      repoRoot: "/repo",
      relPath: "plan.md",
      kind: "markdown",
    },
    events: [revisionEvent(1, "hash-1")],
    content: DOC_TEXT,
    contentHash: "hash-1",
    draft: null,
    ...initial,
  };
  const api = {
    state,
    docState: vi.fn(async () => structuredClone(state)),
    saveDraft: vi.fn(async (draft: Draft) => {
      state.draft = draft;
      return { draft };
    }),
    submitReview: vi.fn(async (req: SubmitReviewRequest) => ({
      review: {
        n: 1,
        revision: req.revision,
        verdict: req.verdict,
        summary: req.summary,
        author: "reviewer",
        ts: new Date().toISOString(),
        opened: [],
        reopened: [],
        resolved: [],
      },
    })),
    revisionText: vi.fn(async () => state.content),
    uploadAttachment: vi.fn(async (image: Blob) => ({
      id: "abcdef123456",
      mime: (image.type || "image/png") as "image/png",
      width: 10,
      height: 10,
    })),
    attachmentUrl: (id: string) => `/att/${id}`,
    eventsUrl: () => "/events",
    kbTerms: vi.fn(async () => ({ notes: [] })),
  } satisfies Api & { state: DocStateResponse };
  return api;
}

/** An EventSource whose lifecycle the test drives. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  static get last(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!;
  }

  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }

  fail() {
    this.onerror?.();
  }

  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

export function makeStore(api = fakeApi()) {
  FakeEventSource.instances = [];
  const store = createDocStore({
    api,
    saveDelayMs: 10,
    sse: { EventSourceImpl: FakeEventSource as unknown as typeof EventSource, backoff: () => 0 },
  });
  return { store, api };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

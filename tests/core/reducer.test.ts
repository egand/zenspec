import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  type AgentResponded,
  type ReviewSubmitted,
  type RevisionPublished,
  type ZenEvent,
} from "../../src/core/events.js";
import {
  gateStatus,
  latestReview,
  latestRevision,
  nextStatus,
  openThreads,
  pendingDrift,
  reduce,
  replay,
  type ThreadTrigger,
} from "../../src/core/reducer.js";
import type {
  DocState,
  MarkdownAnchor,
  NewThread,
  Placement,
  Response,
  ThreadStatus,
} from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

let clock = 0;
const base = (author: string) => ({
  schemaVersion: EVENT_SCHEMA_VERSION as typeof EVENT_SCHEMA_VERSION,
  ts: new Date(Date.UTC(2026, 8, 24, 0, 0, clock++)).toISOString(),
  author,
});

const revision = (n: number, placements?: Record<string, Placement>): RevisionPublished => ({
  ...base("agent"),
  type: "revision_published",
  n,
  contentHash: `hash-${n}`,
  summary: `rev ${n}`,
  ...(placements && { placements }),
});

const review = (
  n: number,
  rev: number,
  verdict: ReviewSubmitted["verdict"],
  changes: Partial<Pick<ReviewSubmitted, "opened" | "reopened" | "replies" | "resolved">> = {},
): ReviewSubmitted => ({
  ...base("reviewer"),
  type: "review_submitted",
  n,
  revision: rev,
  verdict,
  summary: "",
  opened: [],
  reopened: [],
  resolved: [],
  ...changes,
});

const respond = (rev: number, ...responses: Response[]): AgentResponded => ({
  ...base("agent"),
  type: "agent_responded",
  revision: rev,
  responses,
});

const stepChecked = (step: string, checked = true): ZenEvent => ({
  ...base("daemon"),
  type: "step_checked",
  step,
  checked,
});

const drifted = (rev: number): ZenEvent => ({
  ...base("daemon"),
  type: "plan_drifted",
  revision: rev,
  diffSummary: "+1 -1",
});

const closed = (): ZenEvent => ({
  ...base("agent"),
  type: "session_closed",
  by: "agent",
  reason: "done",
});

const anchor = (quote: string, lines: [number, number]): MarkdownAnchor => ({
  type: "markdown",
  rev: 1,
  block: "caching/p1",
  quote,
  prefix: "",
  suffix: "",
  lines,
});

const comment = (id: string, body = `about ${id}`): NewThread => ({
  id,
  kind: "comment",
  body,
  attachments: [],
  anchor: anchor(id, [1, 1]),
});

const reopen = (id: string, body = "still unclear") => ({ id, body, attachments: [] });

const placed = (
  rev: number,
  strategy: Placement["strategy"],
  lines?: [number, number],
): Placement =>
  strategy === 6
    ? { revision: rev, strategy }
    : { revision: rev, strategy, block: "caching/p1", lines };

const status = (state: DocState, id: string) => state.threads[id]?.status;

/** Revision 1, review 1 opening `t1`, then `setup` events to reach a given thread status. */
const withThread = (...setup: ZenEvent[]) =>
  replay([revision(1), review(1, 1, "changes_requested", { opened: [comment("t1")] }), ...setup]);

// Events that bring `t1` into each status, and events that apply each trigger to it.
const reach: Record<ThreadStatus, ZenEvent[]> = {
  open: [],
  addressed: [respond(1, { thread: "t1", action: "edited" })],
  declined: [respond(1, { thread: "t1", action: "declined", note: "out of scope" })],
  outdated: [revision(2, { t1: placed(2, 6) })],
  resolved: [
    respond(1, { thread: "t1", action: "edited" }),
    review(2, 1, "comment", { resolved: ["t1"] }),
  ],
};

const reviewCount = (state: DocState) => state.reviews.length;
const revisionCount = (state: DocState) => state.revisions.length;

const apply: Record<ThreadTrigger, (s: DocState) => ZenEvent> = {
  edited: () => respond(9, { thread: "t1", action: "edited" }),
  answered: () => respond(9, { thread: "t1", action: "answered", note: "yes" }),
  declined: () => respond(9, { thread: "t1", action: "declined", note: "no" }),
  resolve: (s) => review(reviewCount(s) + 1, revisionCount(s), "comment", { resolved: ["t1"] }),
  reopen: (s) =>
    review(reviewCount(s) + 1, revisionCount(s), "comment", { reopened: [reopen("t1")] }),
  block_gone: (s) => revision(revisionCount(s) + 1, { t1: placed(revisionCount(s) + 1, 6) }),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("thread state machine", () => {
  const expected: Record<ThreadStatus, Partial<Record<ThreadTrigger, ThreadStatus>>> = {
    open: {
      edited: "addressed",
      answered: "addressed",
      declined: "declined",
      resolve: "resolved",
      block_gone: "outdated",
    },
    addressed: {
      edited: "addressed",
      answered: "addressed",
      declined: "declined",
      resolve: "resolved",
      reopen: "open",
    },
    declined: {
      edited: "addressed",
      answered: "addressed",
      declined: "declined",
      resolve: "resolved",
      reopen: "open",
    },
    outdated: { resolve: "resolved", reopen: "open" },
    resolved: {},
  };
  const cases = (Object.keys(reach) as ThreadStatus[]).flatMap((from) =>
    (Object.keys(apply) as ThreadTrigger[]).map((trigger) => ({
      from,
      trigger,
      to: expected[from][trigger],
    })),
  );

  it.each(cases)("$from + $trigger -> $to", ({ from, trigger, to }) => {
    const before = withThread(...reach[from]);
    expect(status(before, "t1")).toBe(from);
    expect(nextStatus(from, trigger)).toBe(to);

    const after = reduce(before, apply[trigger](before));
    if (to) {
      expect(status(after, "t1")).toBe(to);
    } else {
      // Invalid transitions keep the status and append no message (placements still update).
      expect(after.threads.t1.status).toBe(from);
      expect(after.threads.t1.messages).toEqual(before.threads.t1.messages);
    }
  });

  it("appends reviewer, agent, and reopen messages with attachments", () => {
    const image = { id: "ab12", mime: "image/png" as const, width: 10, height: 20 };
    const state = replay([
      revision(1),
      review(1, 1, "changes_requested", {
        opened: [{ ...comment("t1", "why?"), attachments: [image] }],
      }),
      respond(1, { thread: "t1", action: "answered", note: "because" }),
      review(2, 1, "changes_requested", {
        reopened: [{ id: "t1", body: "see this", attachments: [image] }],
      }),
      respond(1, { thread: "t1", action: "edited" }),
      review(3, 1, "approved", { resolved: ["t1"] }),
    ]);
    const messages = state.threads.t1.messages.map(
      ({ author, action, body, attachments, review, revision }) => ({
        author,
        action,
        body,
        images: attachments.length,
        review,
        revision,
      }),
    );
    expect(messages).toEqual([
      {
        author: "reviewer",
        action: "comment",
        body: "why?",
        images: 1,
        review: 1,
        revision: undefined,
      },
      {
        author: "agent",
        action: "answered",
        body: "because",
        images: 0,
        review: undefined,
        revision: 1,
      },
      {
        author: "reviewer",
        action: "reopened",
        body: "see this",
        images: 1,
        review: 2,
        revision: undefined,
      },
      { author: "agent", action: "edited", body: "", images: 0, review: undefined, revision: 1 },
      {
        author: "reviewer",
        action: "resolved",
        body: "",
        images: 0,
        review: 3,
        revision: undefined,
      },
    ]);
    expect(state.threads.t1).not.toHaveProperty("body");
    expect(state.reviews.map((r) => [r.opened, r.reopened, r.resolved])).toEqual([
      [["t1"], [], []],
      [[], ["t1"], []],
      [[], [], ["t1"]],
    ]);
  });

  it("updates placements without changing status unless the block is gone", () => {
    const state = withThread(
      respond(1, { thread: "t1", action: "edited" }),
      revision(2, { t1: placed(2, 6), ghost: placed(2, 1, [3, 3]) }),
    );
    expect(state.threads.t1).toMatchObject({ status: "addressed", placement: { strategy: 6 } });
    expect(state.threads).not.toHaveProperty("ghost");
  });
});

describe("invalid and unknown events", () => {
  const start = withThread();

  it.each<[string, ZenEvent]>([
    ["an unknown schema version", { ...revision(2), schemaVersion: 99 } as unknown as ZenEvent],
    ["an unknown event type", { ...base("daemon"), type: "mystery" } as unknown as ZenEvent],
    ["a revision out of sequence", revision(3)],
    ["a review out of sequence", review(3, 1, "approved")],
    ["a review of an unpublished revision", review(2, 2, "approved")],
    ["a response to an unknown thread", respond(1, { thread: "t404", action: "edited" })],
    ["a step checked before approval", stepChecked("s1")],
    ["drift before approval", drifted(1)],
  ])("ignores %s", (_label, event) => {
    expect(reduce(start, event)).toEqual(start);
  });

  it("keeps the original thread when a review reuses its id", () => {
    const after = reduce(start, review(2, 1, "comment", { opened: [comment("t1", "dup")] }));
    expect(after.threads).toEqual(start.threads);
    expect(latestReview(after)?.opened).toEqual([]);
  });

  it("does not mutate the input state", () => {
    const frozen = structuredClone(start);
    reduce(start, respond(1, { thread: "t1", action: "edited" }));
    reduce(start, review(2, 1, "approved", { resolved: ["t1"], opened: [comment("t2")] }));
    expect(start).toEqual(frozen);
  });

  it("ignores everything but a new revision after the session is closed", () => {
    const state = reduce(start, closed());
    expect(reduce(state, respond(1, { thread: "t1", action: "edited" }))).toBe(state);
    expect(reduce(state, review(2, 1, "approved"))).toBe(state);

    const resumed = reduce(state, revision(2));
    expect(resumed.closed).toBeUndefined();
    expect(status(reduce(resumed, respond(2, { thread: "t1", action: "edited" })), "t1")).toBe(
      "addressed",
    );
  });

  it("reopens a closed session on session_reopened and ignores it otherwise", () => {
    const state = reduce(start, closed());
    const reopened = reduce(state, { ...base("agent"), type: "session_reopened" });
    expect(reopened.closed).toBeUndefined();
    expect(reopened.revisions).toEqual(state.revisions);
    expect(reduce(reopened, review(2, 1, "comment")).reviews).toHaveLength(2);
    expect(reduce(start, { ...base("agent"), type: "session_reopened" })).toBe(start);
  });
});

describe("replay", () => {
  it("is deterministic and equals folding reduce from undefined", () => {
    const events = [
      revision(1),
      review(1, 1, "changes_requested", { opened: [comment("t1"), comment("t2")] }),
      respond(
        1,
        { thread: "t1", action: "edited" },
        { thread: "t2", action: "declined", note: "no" },
      ),
      revision(2, { t1: placed(2, 1, [5, 5]), t2: placed(2, 6) }),
      review(2, 2, "approved", { resolved: ["t1"], reopened: [reopen("t2")] }),
    ];
    const folded = events.reduce<DocState | undefined>((s, e) => reduce(s, e), undefined);
    expect(replay(events)).toEqual(folded);
    expect(replay(JSON.parse(JSON.stringify(events)))).toEqual(replay(events));
    expect(replay([])).toEqual(
      reduce(undefined, { ...revision(1), schemaVersion: 0 } as unknown as ZenEvent),
    );
  });
});

describe("selectors", () => {
  const state = replay([
    revision(1),
    review(1, 1, "changes_requested", { opened: [comment("t1"), comment("t2"), comment("t3")] }),
    respond(1, { thread: "t1", action: "edited" }, { thread: "t2", action: "answered" }),
    revision(2),
    review(2, 2, "changes_requested", {
      opened: [comment("t4")],
      reopened: [reopen("t1")],
      resolved: ["t2"],
    }),
  ]);

  it("lists open threads in creation order", () => {
    expect(openThreads(state).map((t) => t.id)).toEqual(["t1", "t3", "t4"]);
  });

  it("returns the latest revision and review", () => {
    expect(latestRevision(state)?.n).toBe(2);
    expect(latestReview(state)).toMatchObject({ n: 2, revision: 2, verdict: "changes_requested" });
    expect(latestRevision(replay([]))).toBeUndefined();
  });

  it("opens the gate only after approval, and keeps it open through drift", () => {
    expect(gateStatus(state)).toEqual({ approved: false, phase: "in_review" });
    const approved = reduce(state, review(3, 2, "approved"));
    expect(gateStatus(approved)).toEqual({
      approved: true,
      phase: "approved",
      approvedRevision: 2,
    });
    const afterDrift = reduce(reduce(approved, drifted(2)), review(4, 2, "changes_requested"));
    expect(gateStatus(afterDrift)).toEqual({
      approved: true,
      phase: "approved",
      approvedRevision: 2,
    });
    expect(afterDrift.drift).toMatchObject([{ revision: 2, diffSummary: "+1 -1" }]);
  });
});

describe("living-plan phases", () => {
  it("moves drafting -> in_review -> approved -> implementing -> done", () => {
    const events: [ZenEvent, DocState["phase"]][] = [
      [revision(1), "drafting"],
      [review(1, 1, "changes_requested", { opened: [comment("t1")] }), "in_review"],
      [revision(2), "in_review"],
      [review(2, 2, "approved", { resolved: ["t1"] }), "approved"],
      [stepChecked("s1", false), "approved"],
      [stepChecked("s1"), "implementing"],
      [drifted(2), "implementing"],
      [review(3, 2, "changes_requested", { opened: [comment("t2")] }), "implementing"],
      [stepChecked("s2"), "implementing"],
      [revision(3), "implementing"],
      [review(4, 3, "approved", { resolved: ["t2"] }), "done"],
      [review(5, 3, "changes_requested"), "done"],
    ];
    let state: DocState | undefined;
    for (const [event, phase] of events) {
      state = reduce(state, event);
      expect(state.phase, event.type).toBe(phase);
    }
    expect(state?.steps).toMatchObject({ s1: { checked: true }, s2: { checked: true } });
    expect(state?.drift).toHaveLength(1);
  });

  it("approves directly from drafting", () => {
    expect(replay([revision(1), review(1, 1, "approved")]).phase).toBe("approved");
  });
});

describe("replies", () => {
  it("appends a reply to an open thread without changing its status", () => {
    const state = reduce(
      withThread(),
      review(2, 1, "comment", { replies: [{ thread: "t1", body: "any news?" }] }),
    );
    expect(status(state, "t1")).toBe("open");
    expect(state.threads.t1!.messages.at(-1)).toMatchObject({
      author: "reviewer",
      action: "reply",
      body: "any news?",
      attachments: [],
      review: 2,
    });
    expect(latestReview(state)?.replied).toEqual(["t1"]);
  });

  it("keeps addressed threads addressed and skips resolved or unknown threads", () => {
    const addressed = reduce(
      withThread(...reach.addressed),
      review(2, 1, "comment", { replies: [{ thread: "t1", body: "thanks" }] }),
    );
    expect(status(addressed, "t1")).toBe("addressed");
    expect(addressed.threads.t1!.messages.at(-1)?.action).toBe("reply");

    const resolved = withThread(...reach.resolved);
    const after = reduce(
      resolved,
      review(3, 1, "comment", {
        replies: [
          { thread: "t1", body: "late" },
          { thread: "t9", body: "?" },
        ],
      }),
    );
    expect(after.threads.t1).toEqual(resolved.threads.t1);
    expect(latestReview(after)?.replied).toEqual([]);
  });

  it("accepts reviews logged before replies existed", () => {
    const legacy = review(2, 1, "comment");
    delete (legacy as Partial<ReviewSubmitted>).replies;
    expect(latestReview(reduce(withThread(), legacy))?.replied).toEqual([]);
  });
});

describe("drift acceptance", () => {
  const accepted = (): ZenEvent => ({ ...base("reviewer"), type: "drift_accepted" });
  const approved = () => replay([revision(1), review(1, 1, "approved"), stepChecked("s1")]);

  it("acknowledges pending drift without changing the phase", () => {
    const drifting = reduce(approved(), drifted(1));
    expect(pendingDrift(drifting)).toHaveLength(1);
    const state = reduce(drifting, accepted());
    expect(state.phase).toBe("implementing");
    expect(pendingDrift(state)).toEqual([]);
    expect(state.drift[0]!.acceptedAt).toBeDefined();
    expect(state.reviews).toHaveLength(1);
  });

  it("is a no-op without pending drift, and later drift is pending again", () => {
    const state = approved();
    expect(reduce(state, accepted())).toBe(state);
    const again = replay([
      revision(1),
      review(1, 1, "approved"),
      drifted(1),
      accepted(),
      drifted(1),
    ]);
    expect(pendingDrift(again).map((d) => d.acceptedAt)).toEqual([undefined]);
  });

  it("treats drift followed by a review as dealt with", () => {
    const state = reduce(reduce(approved(), drifted(1)), review(2, 1, "changes_requested"));
    expect(pendingDrift(state)).toEqual([]);
  });
});

describe("plan §7.1 worked example", () => {
  it("keeps t8 open across an unrelated revision, then addressed, then resolved", () => {
    const t8: NewThread = {
      id: "t8",
      kind: "comment",
      body: "What about write-through for the session table?",
      attachments: [],
      anchor: anchor("cache invalidation via TTL only", [43, 43]),
    };
    const rev2: Placement = { revision: 2, strategy: 1, block: "caching/p1", lines: [53, 53] };
    const rev3: Placement = {
      ...rev2,
      revision: 3,
      strategy: 4,
      score: 0.83,
      matched: "cache invalidation via TTL plus write-through",
    };

    const r1 = replay([revision(1), review(1, 1, "changes_requested", { opened: [t8] })]);
    expect(r1.threads.t8).toMatchObject({ status: "open", openedIn: 1 });

    const r2 = reduce(r1, revision(2, { t8: rev2 }));
    expect(r2.threads.t8).toMatchObject({ status: "open", placement: rev2 });

    const r3 = [revision(3, { t8: rev3 }), respond(3, { thread: "t8", action: "edited" })].reduce(
      reduce,
      r2,
    );
    expect(r3.threads.t8).toMatchObject({ status: "addressed", placement: rev3 });

    const done = reduce(r3, review(2, 3, "approved", { resolved: ["t8"] }));
    expect(done.threads.t8.status).toBe("resolved");
    expect(openThreads(done)).toEqual([]);
    expect(gateStatus(done)).toEqual({ approved: true, phase: "approved", approvedRevision: 3 });
  });
});

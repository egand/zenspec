/** Hand-built reduced state for payload tests (plan §8.3). Shared by format-payload and budget tests. */
import type { PayloadInput } from "../../src/core/format-payload.js";
import type {
  AttachmentRef,
  Choice,
  MarkdownAnchor,
  Message,
  Placement,
  Review,
  Thread,
  ThreadId,
  ThreadSpec,
  Verdict,
} from "../../src/core/types.js";

const TS = "2026-09-24T10:00:00.000Z";
export const DOC_PATH = "docs/plans/x.md";
const ATTACHMENTS = "/Users/egand/.zenspec/repos/zenspec-3f9a1c/docs/docs-plans-x-md/attachments";

/** Realistic attachment path: content-addressed by the first 12 hex chars of the sha256 (§5). */
export const attachmentPath = (id: string) => `${ATTACHMENTS}/${id}.png`;

export const DOCUMENT = [
  "# Session storage",
  "",
  "## Caching",
  "",
  "We rely on cache invalidation via TTL only for sessions and profiles.",
  "The cache sits in front of the primary database and absorbs most reads.",
  "",
  "## Storage",
  "",
  "Use Redis for the session table and Postgres for everything else.",
  "",
  "> [!QUESTION] Which database engine? {#db-engine}",
  "> - PostgreSQL (recommended)",
  "> - SQLite",
  "",
  "Payloads are serialized as JSON between the gateway and workers.",
].join("\n");

export function anchor(quote: string, lines: [number, number]): MarkdownAnchor {
  return { type: "markdown", rev: 1, block: "caching/p1", quote, prefix: "", suffix: "", lines };
}

export function image(seed: number): AttachmentRef {
  return {
    id: seed.toString(16).padStart(12, "9c1e"),
    mime: "image/png",
    width: 1320,
    height: 2248,
  };
}

export function msg(body: string, extra: Partial<Message> = {}): Message {
  return {
    author: "reviewer",
    body,
    action: "comment",
    attachments: [],
    ts: TS,
    review: 1,
    ...extra,
  };
}

export function thread(
  id: ThreadId,
  spec: ThreadSpec,
  messages: Message[],
  extra: Partial<Thread> = {},
): Thread {
  return { ...spec, id, status: "open", messages, openedIn: 1, ...extra } as Thread;
}

export const at = (start: number, end = start): Placement => ({
  revision: 2,
  strategy: 1,
  lines: [start, end],
});

export function review(
  verdict: Verdict,
  opened: ThreadId[],
  reopened: ThreadId[] = [],
  summary = "Mostly good; caching section needs work.",
  replied: ThreadId[] = [],
): Review {
  return {
    n: 3,
    revision: 2,
    verdict,
    summary,
    author: "reviewer",
    ts: TS,
    opened,
    reopened,
    replied,
    resolved: [],
  };
}

const decision = (choice: Choice): ThreadSpec => ({
  kind: "decision",
  anchor: anchor("", [12, 14]),
  question: "db-engine",
  choice,
});

/** Six mixed threads, as in the §8.3 example. */
export function typicalReview(): PayloadInput {
  const threads = [
    thread("t8", { kind: "comment", anchor: anchor("cache invalidation via TTL only", [5, 5]) }, [
      msg("What about write-through for the session table?"),
    ]),
    thread(
      "t9",
      {
        kind: "suggestion",
        anchor: anchor("Use Redis", [10, 10]),
        old: "Use Redis",
        new: "Use Redis (managed, not self-hosted)",
      },
      [msg("")],
    ),
    thread("t10", decision({ mode: "single", option: "PostgreSQL" }), [
      msg("but keep SQLite for tests"),
    ]),
    thread("t12", { kind: "explain", anchor: anchor("JSON", [16, 16]), term: "JSON" }, [
      msg("What is this?"),
    ]),
    thread(
      "t4",
      { kind: "comment", anchor: anchor("Session storage", [1, 1]) },
      [
        msg("Who owns the migration?", { review: 1 }),
        msg("The platform team, see section 4.", {
          author: "agent",
          action: "answered",
          review: undefined,
          revision: 2,
        }),
        msg("Still unclear who owns the migration.", { action: "reopened", review: 3 }),
      ],
      { openedIn: 1 },
    ),
    thread("t11", { kind: "general" }, [
      msg("Can you add a rollback section?", { attachments: [image(1)] }),
    ]),
  ];
  return {
    review: review("changes_requested", ["t8", "t9", "t10", "t12", "t11"], ["t4"]),
    threads,
    placements: { t8: at(5), t9: at(10), t10: at(12, 14), t12: at(16), t4: at(1) },
    docPath: DOC_PATH,
    attachmentPath,
    explain: {
      t12: {
        saveTo: "~/Developer/projects/second-brain/content/02_concepts/json.md",
        template: "~/Developer/projects/second-brain/content/05_templates/concept_template.md",
      },
    },
  };
}

/** Thirty threads cycling through every kind, ~a heavy review. */
export function largeReview(): PayloadInput {
  const threads: Thread[] = [];
  const placements: Record<ThreadId, Placement> = {};
  for (let i = 0; i < 30; i++) {
    const id = `t${i + 1}`;
    const line = 10 + i * 3;
    const spec: ThreadSpec = [
      {
        kind: "comment",
        anchor: anchor(`quoted passage number ${i} from the plan`, [line, line + 1]),
      },
      {
        kind: "suggestion",
        anchor: anchor(`old text ${i}`, [line, line]),
        old: `old text ${i}`,
        new: `new text ${i}`,
      },
      decision({ mode: "multi", options: ["auth", "billing"] }),
      { kind: "explain", anchor: anchor(`term${i}`, [line, line]), term: `term${i}` },
      { kind: "general" },
    ][i % 5] as ThreadSpec;
    threads.push(thread(id, spec, [msg(`Reviewer remark number ${i}, with some detail.`)]));
    if (spec.kind !== "general") placements[id] = at(line, line + (i % 2));
  }
  return {
    review: review(
      "changes_requested",
      threads.map((t) => t.id),
    ),
    threads,
    placements,
    docPath: DOC_PATH,
    attachmentPath,
  };
}

/** Approved with comments: two threads remain open (§8.3). */
export function approvedWithOpenThreads(): PayloadInput {
  return {
    review: review("approved", ["t20", "t21"], [], "Ship it."),
    threads: [
      thread("t20", { kind: "comment", anchor: anchor("absorbs most reads", [6, 6]) }, [
        msg("Careful with step 3."),
      ]),
      thread("t21", { kind: "general" }, [msg("Add metrics later.")]),
    ],
    placements: { t20: at(6) },
    docPath: DOC_PATH,
    attachmentPath,
  };
}

/** A comment review that only replies to two threads that are still open. */
export function repliesReview(): PayloadInput {
  return {
    review: review("comment", [], [], "", ["t8", "t11"]),
    threads: [
      thread("t8", { kind: "comment", anchor: anchor("cache invalidation via TTL only", [5, 5]) }, [
        msg("What about write-through for the session table?"),
        msg("Also: what happens on a cache stampede?", { action: "reply", review: 3 }),
      ]),
      thread("t11", { kind: "general" }, [
        msg("Can you add a rollback section?"),
        msg("See the attached flow.", { action: "reply", review: 3, attachments: [image(2)] }),
      ]),
    ],
    placements: { t8: at(5) },
    docPath: DOC_PATH,
    attachmentPath,
  };
}

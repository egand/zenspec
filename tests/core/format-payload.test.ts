import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildClosedPayload,
  buildPayload,
  buildPendingPayload,
  formatPayloadYaml,
  lineRef,
  truncateQuote,
} from "../../src/core/format-payload.js";
import {
  anchor,
  approvedWithOpenThreads,
  at,
  attachmentPath,
  image,
  msg,
  review,
  thread,
  typicalReview,
} from "./payload-fixtures.js";
import type { Choice } from "../../src/core/types.js";

describe("buildPayload", () => {
  it("emits only the §8.3 fields per thread kind", () => {
    expect(buildPayload(typicalReview())).toEqual({
      verdict: "changes_requested",
      review: 3,
      revision: 2,
      summary: "Mostly good; caching section needs work.",
      threads: [
        {
          id: "t8",
          kind: "comment",
          at: "L5",
          quote: "cache invalidation via TTL only",
          body: "What about write-through for the session table?",
        },
        {
          id: "t9",
          kind: "suggestion",
          at: "L10",
          old: "Use Redis",
          new: "Use Redis (managed, not self-hosted)",
        },
        {
          id: "t10",
          kind: "decision",
          question: "db-engine",
          at: "L12-14",
          choice: "PostgreSQL",
          body: "but keep SQLite for tests",
        },
        {
          id: "t12",
          kind: "explain",
          term: "JSON",
          at: "L16",
          body: "What is this?",
          save_to: "~/Developer/projects/second-brain/content/02_concepts/json.md",
          template: "~/Developer/projects/second-brain/content/05_templates/concept_template.md",
        },
        {
          id: "t4",
          reopened: true,
          kind: "comment",
          at: "L1",
          quote: "Session storage",
          body: "Still unclear who owns the migration.",
        },
        {
          id: "t11",
          kind: "general",
          body: "Can you add a rollback section?",
          images: [{ path: attachmentPath(image(1).id), width: 1320, height: 2248 }],
        },
      ],
      next: "zenspec review docs/plans/x.md -r <id>:<edited|answered|declined>[:note]",
    });
  });

  it("maps every decision choice mode", () => {
    const choices: [Choice, unknown][] = [
      [{ mode: "multi", options: ["auth", "billing"] }, ["auth", "billing"]],
      [{ mode: "rating", value: 4 }, 4],
      [{ mode: "other" }, "other"],
    ];
    for (const [choice, expected] of choices) {
      const input = {
        ...typicalReview(),
        threads: [
          thread("t1", { kind: "decision", anchor: anchor("", [1, 2]), question: "q", choice }, [
            msg("write-in"),
          ]),
        ],
      };
      const [t] = buildPayload(input).threads!;
      expect(t).toMatchObject({ choice: expected, body: "write-in" });
    }
  });

  it("omits `at` for outdated or missing placements", () => {
    expect(lineRef(undefined)).toBeUndefined();
    expect(lineRef({ revision: 2, strategy: 6 })).toBeUndefined();
    expect(lineRef(at(7, 7))).toBe("L7");
    const input = { ...typicalReview(), placements: {} };
    expect(buildPayload(input).threads!.some((t) => "at" in t)).toBe(false);
  });

  it("drops resolved threads", () => {
    const input = typicalReview();
    input.threads[0] = { ...input.threads[0]!, status: "resolved" };
    expect(buildPayload(input).threads!.map((t) => t.id)).not.toContain("t8");
  });

  it("marks open threads and points to the living-plan workflow on approval", () => {
    const payload = buildPayload(approvedWithOpenThreads());
    expect(payload.threads!.every((t) => t.status === "open")).toBe(true);
    expect(payload.next).toBe(
      "implement, ticking each step's checkbox; then zenspec review docs/plans/x.md -m implemented -r <id>:<action>[:note]",
    );
    const clean = { ...approvedWithOpenThreads(), threads: [], review: review("approved", []) };
    expect(buildPayload(clean).next).toBe(
      "implement, ticking each step's checkbox; then zenspec review docs/plans/x.md -m implemented",
    );
    expect(buildPayload({ ...clean, phase: "done" }).next).toBe("done; no further action");
  });

  it("omits an empty summary and thread list", () => {
    const payload = buildPayload({
      ...typicalReview(),
      threads: [],
      review: review("comment", [], [], ""),
    });
    expect(payload).toEqual({
      verdict: "comment",
      review: 3,
      revision: 2,
      next: "zenspec review docs/plans/x.md",
    });
  });

  it("shell-quotes document paths", () => {
    expect(buildPendingPayload("docs/my plan's.md").next).toBe(
      `zenspec review 'docs/my plan'\\''s.md'`,
    );
  });
});

describe("buildPendingPayload", () => {
  it("returns the same command to resume waiting", () => {
    expect(buildPendingPayload("docs/plans/x.md", "10m")).toEqual({
      verdict: "pending",
      next: "zenspec review docs/plans/x.md --wait 10m",
    });
  });
});

describe("buildClosedPayload", () => {
  it("says who closed the session and that nothing is left to do", () => {
    expect(buildClosedPayload("reviewer", "superseded")).toEqual({
      verdict: "closed",
      by: "reviewer",
      reason: "superseded",
      next: "none",
    });
    expect(buildClosedPayload("agent", "")).toEqual({
      verdict: "closed",
      by: "agent",
      next: "none",
    });
  });
});

describe("truncateQuote", () => {
  it("flattens whitespace and caps at 120 code points", () => {
    expect(truncateQuote("  a\n  b  ")).toBe("a b");
    expect(truncateQuote(" ")).toBeUndefined();
    const long = truncateQuote("é".repeat(300))!;
    expect([...long]).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("formatPayloadYaml", () => {
  it("puts verdict on the first line and round-trips", () => {
    const payload = buildPayload(typicalReview());
    const yaml = formatPayloadYaml(payload);
    expect(yaml.split("\n")[0]).toBe("verdict: changes_requested");
    const parsed = parse(yaml);
    expect(parsed.threads[5].images).toEqual([attachmentPath(image(1).id)]);
    expect({ ...parsed, threads: parsed.threads.slice(0, 5) }).toEqual({
      ...payload,
      threads: payload.threads!.slice(0, 5),
    });
  });

  it("writes plain UTF-8, never HTML-escaped", () => {
    const input = typicalReview();
    input.threads = [thread("t1", { kind: "general" }, [msg("it's <b>bold</b> & naïve 🚀")])];
    const yaml = formatPayloadYaml(buildPayload(input));
    expect(yaml).toContain("it's <b>bold</b> & naïve 🚀");
    expect(yaml).not.toMatch(/&#\d+;|&amp;|&lt;|\\u/);
  });

  it("renders images as a path with dimensions in a comment", () => {
    const yaml = formatPayloadYaml(buildPayload(typicalReview()));
    expect(yaml).toContain(`      - ${attachmentPath(image(1).id)} # 1320x2248\n`);
  });

  it("stays compact: no nulls, no needless quotes, multi-line text as literal blocks", () => {
    const input = typicalReview();
    input.threads.push(thread("t30", { kind: "general" }, [msg("line one\nline two")]));
    const yaml = formatPayloadYaml(buildPayload(input));
    expect(yaml).not.toMatch(/null|: ""|~$/m);
    expect(yaml).toContain("    at: L12-14\n");
    expect(yaml).toContain("    choice: PostgreSQL\n");
    expect(yaml).toContain("    body: |-\n      line one\n      line two\n");
  });

  it("formats a pending payload as two lines", () => {
    expect(formatPayloadYaml(buildPendingPayload("docs/plans/x.md"))).toBe(
      "verdict: pending\nnext: zenspec review docs/plans/x.md\n",
    );
  });

  it("formats a closed payload with who closed it first", () => {
    expect(formatPayloadYaml(buildClosedPayload("reviewer", "done"))).toBe(
      "verdict: closed\nby: reviewer\nreason: done\nnext: none\n",
    );
  });
});

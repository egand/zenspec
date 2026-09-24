/**
 * Cost-budget invariants (plan §3). These fail loudly when the payload grows: raise a budget
 * only with a plan change.
 */
import { describe, expect, it } from "vitest";
import {
  buildPayload,
  buildPendingPayload,
  formatPayloadYaml,
  QUOTE_MAX_CHARS,
  type PayloadInput,
} from "../../src/core/format-payload.js";
import type { PayloadThread, ReviewPayload } from "../../src/core/payload.js";
import { estimateTokens } from "../../src/core/tokens.js";
import {
  anchor,
  approvedWithOpenThreads,
  attachmentPath,
  DOC_PATH,
  DOCUMENT,
  image,
  largeReview,
  msg,
  thread,
  typicalReview,
} from "./payload-fixtures.js";

const REVIEW_OVERHEAD = 80;
const THREAD_OVERHEAD = 25;
/** Whole image entry, path included: paths are payload data, budgeted apart from overhead. */
const IMAGE_ENTRY = 45;

/**
 * Replaces every human-written string, quote, and file path with one character, keeping the
 * keys. File paths (images, `save_to`, `template`) grow with the user's directory layout, so
 * they are budgeted separately below.
 */
function withoutVariableText(payload: ReviewPayload): ReviewPayload {
  const h = (s: string | undefined) => (s === undefined ? undefined : "x");
  const strip = (t: PayloadThread): PayloadThread => {
    const out: Record<string, unknown> = { ...t };
    for (const key of ["body", "quote", "old", "new", "term", "save_to", "template"] as const) {
      if (key in out) out[key] = "x";
    }
    if ("choice" in t && typeof t.choice !== "number") {
      out.choice = Array.isArray(t.choice) ? t.choice.map(() => "x") : "x";
    }
    if (t.images) out.images = t.images.map((i) => ({ ...i, path: "x" }));
    return out as unknown as PayloadThread;
  };
  return { ...payload, summary: h(payload.summary), threads: payload.threads?.map(strip) };
}

const overhead = (payload: ReviewPayload) =>
  estimateTokens(formatPayloadYaml(withoutVariableText(payload)));

const fixtures: [string, ReviewPayload][] = [
  ["typical (6 mixed threads)", buildPayload(typicalReview())],
  ["large (30 threads)", buildPayload(largeReview())],
  ["approved with open threads", buildPayload(approvedWithOpenThreads())],
  ["pending", buildPendingPayload(DOC_PATH, "10m")],
];

describe("payload budget (§3)", () => {
  it.each(fixtures)("%s: overhead ≤ 80 per review + 25 per thread", (_name, payload) => {
    const threads = payload.threads?.length ?? 0;
    const measured = overhead(payload);
    const budget = REVIEW_OVERHEAD + THREAD_OVERHEAD * threads;
    expect(
      measured,
      `${measured} tokens > budget ${budget} (${threads} threads)`,
    ).toBeLessThanOrEqual(budget);
  });

  it("truncates quotes to 120 characters", () => {
    const input = typicalReview();
    input.threads = [
      thread("t1", { kind: "comment", anchor: anchor("word ".repeat(200), [1, 9]) }, [msg("hm")]),
    ];
    const [t] = buildPayload(input).threads!;
    expect(t && "quote" in t && [...t.quote!].length).toBe(QUOTE_MAX_CHARS);
  });

  it("costs at most 45 tokens per image entry, path included, and never inlines image data", () => {
    const withImages = (n: number): PayloadInput => ({
      ...typicalReview(),
      threads: [
        thread("t1", { kind: "general" }, [
          msg("see screenshots", { attachments: Array.from({ length: n }, (_, i) => image(i)) }),
        ]),
      ],
    });
    expect(attachmentPath(image(0).id)).toMatch(
      /^\/Users\/[^/]+\/\.zenspec\/repos\/[^/]+\/docs\/[^/]+\/attachments\/[0-9a-f]{12}\.png$/,
    );
    const cost = (n: number) => estimateTokens(formatPayloadYaml(buildPayload(withImages(n))));
    const [zero, one, two] = [cost(0), cost(1), cost(2)];
    // The first image also pays for the `images:` key.
    expect(one - zero).toBeLessThanOrEqual(IMAGE_ENTRY);
    expect(two - one).toBeLessThanOrEqual(IMAGE_ENTRY);
    expect(formatPayloadYaml(buildPayload(withImages(2)))).not.toMatch(/base64|data:image/);
  });

  it("never contains the document, history, or resolved threads", () => {
    const input = typicalReview();
    input.threads.push(
      thread(
        "t2",
        { kind: "comment", anchor: anchor("absorbs most reads", [6, 6]) },
        [msg("Resolved remark.")],
        {
          status: "resolved",
        },
      ),
    );
    const yaml = formatPayloadYaml(buildPayload(input));
    // Quotes are substrings of their lines, so no full document line may appear.
    for (const line of DOCUMENT.split("\n").filter((l) => l.length > 20)) {
      expect(yaml).not.toContain(line);
    }
    expect(yaml).not.toMatch(/\bt2\b|Resolved remark/);
    // t4 was reopened: only the reopen message is delivered, not its earlier exchange.
    expect(yaml).not.toMatch(/Who owns the migration\?|platform team/);
  });

  it.todo("exactly one CLI invocation per review round in the scripted-agent test");
});

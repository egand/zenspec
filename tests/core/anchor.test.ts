import { describe, expect, it } from "vitest";
import {
  createMarkdownAnchor,
  reanchor,
  reanchorDraft,
  reanchorThreads,
  type HtmlSnapshot,
  type MarkdownSnapshot,
} from "../../src/core/anchor.js";
import { diffHunks, likelyAddressed } from "../../src/core/diff.js";
import type { Block, DraftThread, HtmlAnchor, Thread } from "../../src/core/types.js";

/**
 * Stand-in for the parser: blocks are separated by blank lines; headings get the slug of
 * their title and other blocks `<section slug>/p<ordinal>`.
 */
function snapshot(text: string, revision = 1): MarkdownSnapshot {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let section = "root";
  let ordinal = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    let end = i;
    while (end + 1 < lines.length && lines[end + 1]!.trim()) end++;
    const source = lines.slice(i, end + 1).join("\n");
    const heading = /^#+\s+(.*)/.exec(source);
    if (heading) {
      section = heading[1]!.toLowerCase().replace(/\W+/g, "-");
      ordinal = 0;
    }
    const id = heading ? section : `${section}/p${++ordinal}`;
    blocks.push({ id, type: heading ? "heading" : "paragraph", lines: [i + 1, end + 1], source });
    i = end;
  }
  return { kind: "markdown", revision, text, blocks };
}

function anchorOn(doc: MarkdownSnapshot, quote: string, occurrence = 0) {
  let start = -1;
  for (let n = 0; n <= occurrence; n++) start = doc.text.indexOf(quote, start + 1);
  return createMarkdownAnchor(doc, { start, end: start + quote.length });
}

describe("§7.1 worked example: one comment across three revisions", () => {
  const intro = Array.from({ length: 36 }, (_, i) => `Intro line ${i + 1}.`);
  const caching = [
    "## Caching",
    "",
    "Sessions are cached in Redis and we rely on",
    "cache invalidation via TTL only for sessions.",
  ];
  const security = ["", "## Security", "", ...Array.from({ length: 7 }, (_, i) => `Rule ${i}.`)];
  const rev1 = snapshot(["# Plan", "", ...intro, "", ...caching].join("\n"), 1);
  const rev2 = snapshot(["# Plan", "", ...intro, ...security, "", ...caching].join("\n"), 2);
  const rev3 = snapshot(rev2.text.replace("TTL only for", "TTL plus write-through for"), 3);
  const t8 = anchorOn(rev1, "cache invalidation via TTL only");

  it("captures the selector at revision 1 (L43)", () => {
    expect(t8).toEqual({
      type: "markdown",
      rev: 1,
      block: "caching/p1",
      quote: "cache invalidation via TTL only",
      prefix: "ing\n\nSessions are cached in Redis and we rely on\n".slice(-32),
      suffix: " for sessions.",
      lines: [43, 43],
    });
  });

  it("follows 10 inserted lines by exact context (strategy 1, L53) without a hint", () => {
    const placement = reanchor(t8, rev2);
    expect(placement).toEqual({ revision: 2, strategy: 1, block: "caching/p1", lines: [53, 53] });
    const before = { revision: 1, strategy: 1 as const, lines: t8.lines };
    expect(likelyAddressed(before, diffHunks(rev1.text, rev2.text))).toBe(false);
  });

  it("follows the rewritten sentence by fuzzy match (strategy 4, L53) with a hint", () => {
    const previous = reanchor(t8, rev2);
    const placement = reanchor(t8, rev3);
    expect(placement).toMatchObject({
      revision: 3,
      strategy: 4,
      block: "caching/p1",
      lines: [53, 53],
    });
    expect(placement.matched).toMatch(/^cache invalidation via TTL plu/);
    expect(placement.score).toBeGreaterThanOrEqual(0.8);
    expect(likelyAddressed(previous, diffHunks(rev2.text, rev3.text))).toBe(true);
  });
});

describe("markdown re-anchoring strategies", () => {
  const base = [
    "## Storage",
    "",
    "We keep the cache warm with a nightly job.",
    "",
    "## Ops",
    "",
    "The cache is flushed on deploy.",
  ].join("\n");
  const doc = snapshot(base);
  const quote = "keep the cache warm";
  const anchor = anchorOn(doc, quote);

  it.each([
    {
      name: "2: quote inside the same block when the context changed",
      text: base.replace("We keep the cache warm with", "Now we keep the cache warm through"),
      strategy: 2,
      block: "storage/p1",
    },
    {
      name: "3: unique quote elsewhere when the block is gone",
      text: base.replace("## Storage", "## Persistence").replace("We keep", "Also, keep"),
      strategy: 3,
      block: "persistence/p1",
    },
    {
      name: "4: fuzzy match inside the block (rewrapped and reworded)",
      text: base.replace("We keep the cache warm with", "We keep the\ncaches warm with"),
      strategy: 4,
      block: "storage/p1",
    },
    {
      name: "4: unique fuzzy match anywhere when the block is gone",
      text: base
        .replace("## Storage", "## Persistence")
        .replace("the cache warm", "the caches warm"),
      strategy: 4,
      block: "persistence/p1",
    },
    {
      name: "5: whole block when the quote is gone but the block survives",
      text: base.replace("keep the cache warm", "precompute nothing"),
      strategy: 5,
      block: "storage/p1",
    },
    {
      name: "6: outdated when the block and the quote are gone",
      text: base.replace("## Storage\n\nWe keep the cache warm with a nightly job.\n\n", ""),
      strategy: 6,
      block: undefined,
    },
  ])("strategy $name", ({ text, strategy, block }) => {
    const placement = reanchor(anchor, snapshot(text, 2));
    expect(placement.strategy).toBe(strategy);
    expect(placement.block).toBe(block);
    if (strategy <= 4) expect(placement.matched ?? quote).toMatch(/keep the\s+caches? warm/);
  });

  it("never guesses between duplicate quotes once the block is gone", () => {
    const dup = snapshot(
      "## A\n\nThe cache is hot.\n\n## B\n\nThe cache is hot.\n\n## C\n\nOther.",
    );
    const first = anchorOn(dup, "cache is hot");
    const second = anchorOn(dup, "cache is hot", 1);
    expect(second.block).toBe("b/p1");

    // Context disambiguates: each anchor keeps its own occurrence.
    const shifted = snapshot(`Preface.\n\n${dup.text}`, 2);
    expect(reanchor(second, shifted).lines).toEqual([9, 9]);

    // Its block renamed and its context changed: two equal candidates remain, so outdated.
    const renamed = snapshot(dup.text.replace("## A\n\nThe", "## Z\n\nA"), 2);
    expect(reanchor(first, renamed)).toEqual({ revision: 2, strategy: 6 });
  });

  it("anchors a whole block with an empty quote", () => {
    const anchor = createMarkdownAnchor(doc, { block: "ops/p1" });
    expect(anchor).toMatchObject({ quote: "", lines: [7, 7] });
    const moved = snapshot(`Preface.\n\n${base}`, 2);
    expect(reanchor(anchor, moved)).toMatchObject({ strategy: 5, block: "ops/p1", lines: [9, 9] });
  });

  it("rejects selections outside every block", () => {
    expect(() => createMarkdownAnchor(doc, { start: 11, end: 12 })).toThrow(/outside every block/);
  });
});

describe("deleted blocks", () => {
  const rev1 = snapshot(
    [
      "## Caching",
      "",
      "Sessions are cached in Redis.",
      "",
      "Eviction uses an LRU policy with a 10k entry cap.",
      "",
      "Metrics are exported to Prometheus every minute.",
    ].join("\n"),
  );
  const rev2 = snapshot(
    rev1.text.replace("Eviction uses an LRU policy with a 10k entry cap.\n\n", ""),
    2,
  );
  const onDeleted = anchorOn(rev1, "LRU policy");

  it("outdates a thread whose paragraph was deleted instead of moving it to the next one", () => {
    expect(onDeleted.block).toBe("caching/p2");
    expect(rev2.blocks.map((b) => b.id)).toContain("caching/p2");
    expect(reanchor(onDeleted, rev2)).toEqual({ revision: 2, strategy: 6 });
  });

  it("outdates a whole-block anchor whose block was deleted", () => {
    const anchor = createMarkdownAnchor(rev1, { block: "caching/p2" });
    expect(reanchor(anchor, rev2)).toEqual({ revision: 2, strategy: 6 });
  });

  it("orphans draft items and outdates threads on the deleted paragraph", () => {
    const [item] = reanchorDraft(
      [{ kind: "comment", anchor: onDeleted, draftId: "d", body: "", attachments: [] }],
      rev2,
    );
    expect(item).toMatchObject({ orphaned: true, placement: { strategy: 6 } });
    const thread: Thread = {
      kind: "comment",
      anchor: onDeleted,
      id: "t1",
      status: "open",
      messages: [],
      openedIn: 1,
    };
    expect(reanchorThreads([thread], rev2)).toEqual({ t1: { revision: 2, strategy: 6 } });
  });

  it("keeps a thread on its paragraph when a later paragraph is deleted", () => {
    const rev3 = snapshot(
      rev1.text.replace("\n\nMetrics are exported to Prometheus every minute.", ""),
      2,
    );
    const rewritten = snapshot(rev3.text.replace("LRU policy", "clock sweep"), 3);
    expect(reanchor(onDeleted, rewritten)).toMatchObject({ strategy: 5, block: "caching/p2" });
  });
});

describe("batch re-anchoring", () => {
  const rev1 = snapshot("## Keep\n\nStays here.\n\n## Drop\n\nWill vanish.");
  const rev2 = snapshot("Added.\n\n## Keep\n\nStays here.", 2);
  const kept = anchorOn(rev1, "Stays here");
  const dropped = anchorOn(rev1, "Will vanish");

  it("marks draft items whose target disappeared as orphaned, keeping their quote", () => {
    const item = (draftId: string, anchor = kept): DraftThread => ({
      kind: "comment",
      anchor,
      draftId,
      body: "",
      attachments: [],
    });
    const general: DraftThread = { kind: "general", draftId: "g", body: "hi", attachments: [] };
    const [survivor, orphan, untouched] = reanchorDraft(
      [{ ...item("a"), orphaned: true }, item("b", dropped), general],
      rev2,
    );
    expect(survivor).toMatchObject({
      orphaned: undefined,
      placement: { strategy: 2, lines: [5, 5] },
    });
    expect(orphan).toMatchObject({
      orphaned: true,
      anchor: { quote: "Will vanish" },
      placement: { strategy: 6 },
    });
    expect(untouched).toBe(general);
  });

  it("re-anchors every unresolved anchored thread", () => {
    const thread = (id: string, status: Thread["status"], anchor = kept): Thread => ({
      kind: "comment",
      anchor,
      id,
      status,
      messages: [],
      openedIn: 1,
    });
    const general: Thread = {
      kind: "general",
      id: "t4",
      status: "open",
      messages: [],
      openedIn: 1,
    };
    const placements = reanchorThreads(
      [thread("t1", "open"), thread("t2", "addressed", dropped), thread("t3", "resolved"), general],
      rev2,
    );
    expect(placements).toEqual({
      t1: { revision: 2, strategy: 2, block: "keep/p1", lines: [5, 5] },
      t2: { revision: 2, strategy: 6 },
    });
  });

  it("outdates an anchor re-anchored against the other document kind", () => {
    const html: HtmlSnapshot = { kind: "html", revision: 2, elements: [] };
    expect(reanchor(kept, html)).toEqual({ revision: 2, strategy: 6 });
  });
});

describe("HTML re-anchoring", () => {
  const anchor: HtmlAnchor = {
    type: "html",
    rev: 1,
    cssPath: "main > section:nth-child(2) > button",
    tag: "button",
    textQuote: "Save  changes",
  };
  const html = (...elements: HtmlSnapshot["elements"]): HtmlSnapshot => ({
    kind: "html",
    revision: 2,
    elements,
  });

  it("finds the text among same-tag elements after the element moved", () => {
    const placement = reanchor(
      anchor,
      html(
        { cssPath: "main > p", tag: "p", text: "Save changes" },
        { cssPath: "footer > button:nth-child(1)", tag: "button", text: "Cancel" },
        { cssPath: "footer > button:nth-child(2)", tag: "BUTTON", text: " Save changes " },
      ),
    );
    expect(placement).toEqual({
      revision: 2,
      strategy: 2,
      cssPath: "footer > button:nth-child(2)",
      matched: " Save changes ",
    });
  });

  it("prefers the element that kept its path among identical texts", () => {
    const placement = reanchor(
      anchor,
      html(
        { cssPath: "header > button", tag: "button", text: "Save changes" },
        { cssPath: anchor.cssPath, tag: "button", text: "Save changes" },
      ),
    );
    expect(placement).toMatchObject({ strategy: 2, cssPath: anchor.cssPath });
  });

  it("falls back to the CSS path when the text changed, then to outdated", () => {
    const relabeled = html({ cssPath: anchor.cssPath, tag: "button", text: "Apply" });
    expect(reanchor(anchor, relabeled)).toMatchObject({ strategy: 3, cssPath: anchor.cssPath });
    const retagged = html({ cssPath: anchor.cssPath, tag: "a", text: "Save changes" });
    expect(reanchor(anchor, retagged)).toEqual({ revision: 2, strategy: 6 });
  });
});

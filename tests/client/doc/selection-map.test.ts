import { describe, expect, it } from "vitest";
import { parseDocument } from "../../../src/core/parse.js";
import { linesOf, mapSelection } from "../../../src/client/doc/selection/map.js";

/** Maps `quote` inside the first block of `source` and returns the matched source slice. */
function pick(source: string, quote: string, hint?: number, blockIndex = 0) {
  const block = parseDocument(source).blocks[blockIndex]!;
  const span = mapSelection(source, block.node, quote, hint);
  return span && { ...span, text: source.slice(span.start, span.end) };
}

describe("mapSelection", () => {
  it("finds rendered text across inline markup", () => {
    const source = "We cache **reads** with a _short_ TTL.\n";
    expect(pick(source, "reads with a short")?.text).toBe("reads** with a _short");
    expect(pick(source, "reads")).toMatchObject({ start: 11, end: 16 });
  });

  it("skips link destinations, inline code ticks and escapes", () => {
    const source = "See [the docs](https://example.com/x) and `npm test` \\*now\\*.\n";
    expect(pick(source, "the docs and npm test")?.text).toBe(
      "the docs](https://example.com/x) and `npm test",
    );
    expect(pick(source, "*now*")?.text).toBe("*now\\*");
  });

  it("tolerates blockquote prefixes and line breaks inside a selection", () => {
    const source = "Intro.\n\n> first line\n> second line\n";
    expect(pick(source, "line\nsecond", 0, 1)?.text).toBe("line\n> second");
  });

  it("maps fenced code without matching the info string", () => {
    const source = "```ts\ntest(ttl);\n```\n";
    expect(pick(source, "t")).toMatchObject({ start: 6, text: "t" });
    expect(pick(source, "ttl")?.text).toBe("ttl");
  });

  it("uses the rendered offset hint to pick among repeated quotes", () => {
    const source = "cache one, cache two, cache three\n";
    const first = pick(source, "cache", 0)!;
    const third = pick(source, "cache", 20)!;
    expect(first.start).toBe(0);
    expect(third.start).toBe(source.lastIndexOf("cache"));
  });

  it("returns null when the text is not in the block", () => {
    expect(pick("Some paragraph.\n", "elsewhere")).toBeNull();
  });

  it("computes 1-based inclusive line ranges", () => {
    const source = "a\nbb\nccc\n";
    expect(linesOf(source, 2, 4)).toEqual([2, 2]);
    expect(linesOf(source, 0, 8)).toEqual([1, 3]);
  });
});

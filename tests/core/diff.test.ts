import { describe, expect, it } from "vitest";
import { diffHunks, diffLines, likelyAddressed } from "../../src/core/diff.js";
import type { Placement } from "../../src/core/types.js";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lcsLength(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = x === b[j - 1] ? diag + 1 : Math.max(up, row[j - 1]!);
      diag = up;
    }
  }
  return row[b.length]!;
}

const text = (lines: string[]) => lines.map((l) => `${l}\n`).join("");

describe("diffLines", () => {
  it("produces a minimal edit script that rebuilds both revisions", () => {
    const next = random(42);
    for (let run = 0; run < 300; run++) {
      const gen = () =>
        Array.from({ length: Math.floor(next() * 30) }, () => "abcde"[Math.floor(next() * 5)]!);
      const a = gen();
      const b = gen();
      const lines = diffLines(text(a), text(b));
      expect(lines.filter((l) => l.op !== "insert").map((l) => l.text)).toEqual(a);
      expect(lines.filter((l) => l.op !== "delete").map((l) => l.text)).toEqual(b);
      expect(lines.filter((l) => l.op === "equal")).toHaveLength(lcsLength(a, b));
    }
  });

  it("diffs a 2,000-line document in under 50 ms", () => {
    const next = random(7);
    const a = Array.from({ length: 2000 }, (_, i) => `Line ${i}: ${next().toString(36)}`);
    const b = a.flatMap((line, i) => {
      if (i % 20 === 0) return [`${line} (edited)`];
      if (i % 20 === 7) return [];
      if (i % 20 === 13) return [line, "inserted"];
      return [line];
    });
    const oldText = text(a);
    const newText = text(b);
    const t0 = performance.now();
    const hunks = diffHunks(oldText, newText);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(hunks.length).toBeGreaterThan(0);
  });
});

describe("diffHunks", () => {
  const old = text(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"]);

  it("groups changes with context and merges nearby ones", () => {
    const changed = text(["a", "B", "c", "d", "e", "f", "g", "h", "i", "j", "k", "x", "l"]);
    const hunks = diffHunks(old, changed, 1);
    expect(hunks.map(({ lines: _, ...range }) => range)).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 },
      { oldStart: 11, oldLines: 3, newStart: 11, newLines: 3 },
    ]);
    expect(hunks[1]!.lines.map((l) => `${l.op[0]}${l.text}`)).toEqual(["ek", "ix", "el", "dm"]);
    expect(diffHunks(old, changed, 5)).toHaveLength(1);
  });

  it("locates pure insertions and deletions without context", () => {
    const inserted = old.replace("b\n", "b\nnew\n");
    expect(diffHunks(old, inserted, 0)).toEqual([
      {
        oldStart: 3,
        oldLines: 0,
        newStart: 3,
        newLines: 1,
        lines: [{ op: "insert", text: "new", newLine: 3 }],
      },
    ]);
    expect(diffHunks("a\nb\n", "a\n", 0)).toEqual([
      {
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 0,
        lines: [{ op: "delete", text: "b", oldLine: 2 }],
      },
    ]);
  });
});

describe("likelyAddressed", () => {
  const old = text(["one", "two", "three", "four", "five"]);
  const at = (lines: [number, number]): Placement => ({ revision: 1, strategy: 1, lines });

  it.each([
    { name: "edited inside the range", next: ["one", "two", "THREE", "four", "five"], hit: true },
    {
      name: "inserted between its lines",
      next: ["one", "two", "new", "three", "four", "five"],
      hit: true,
    },
    {
      name: "inserted just above it",
      next: ["one", "new", "two", "three", "four", "five"],
      hit: false,
    },
    { name: "edited just below it", next: ["one", "two", "three", "FOUR", "five"], hit: false },
  ])("range L2-L3, $name → $hit", ({ next, hit }) => {
    expect(likelyAddressed(at([2, 3]), diffHunks(old, text(next)))).toBe(hit);
  });

  it("gives no hint for outdated placements", () => {
    expect(likelyAddressed({ revision: 1, strategy: 6 }, diffHunks(old, ""))).toBe(false);
  });
});

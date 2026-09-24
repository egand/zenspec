/**
 * Markdown anchors (plan §7): capture a W3C-style text selector, and re-anchor it
 * against a later revision with six strategies tried in order.
 */
import type { Block, BlockId, LineRange, MarkdownAnchor, Placement } from "../types.js";
import { fuzzyFind } from "./fuzzy.js";

/** Characters of context kept on each side of the quote. */
export const CONTEXT_CHARS = 32;
/** Minimal similarity for a fuzzy match (strategy 4). */
export const FUZZY_THRESHOLD = 0.8;

/** A Markdown revision: its source text and the blocks parsed from it. */
export interface MarkdownSnapshot {
  kind: "markdown";
  revision: number;
  text: string;
  blocks: Block[];
}

/** Character offsets into the snapshot text (end exclusive), or a whole block. */
export type TextSelection = { start: number; end: number } | { block: BlockId };

export function createMarkdownAnchor(
  doc: MarkdownSnapshot,
  selection: TextSelection,
): MarkdownAnchor {
  const lines = new LineIndex(doc.text);
  if ("block" in selection) {
    const block = doc.blocks.find((b) => b.id === selection.block);
    if (!block) throw new Error(`Unknown block: ${selection.block}`);
    const base = { type: "markdown", rev: doc.revision, block: block.id } as const;
    return { ...base, quote: "", prefix: "", suffix: "", lines: block.lines };
  }
  const { start, end } = selection;
  if (start < 0 || end <= start || end > doc.text.length) {
    throw new Error(`Invalid selection: [${start}, ${end})`);
  }
  const range = lines.rangeOf(start, end);
  const block = blockAt(doc.blocks, range[0]);
  if (!block) throw new Error(`Selection at line ${range[0]} is outside every block`);
  return {
    type: "markdown",
    rev: doc.revision,
    block: block.id,
    quote: doc.text.slice(start, end),
    prefix: doc.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: doc.text.slice(end, end + CONTEXT_CHARS),
    lines: range,
  };
}

export function reanchorMarkdown(anchor: MarkdownAnchor, doc: MarkdownSnapshot): Placement {
  const { text, blocks, revision } = doc;
  const lines = new LineIndex(text);
  const block = blocks.find((b) => b.id === anchor.block);
  const blockSpan = block && lines.spanOf(block.lines);
  const placeAt = (strategy: 1 | 2 | 3 | 4, start: number, end: number, score?: number) => {
    const range = lines.rangeOf(start, end);
    const placement: Placement = { revision, strategy, lines: range };
    const at = blockAt(blocks, range[0]);
    if (at) placement.block = at.id;
    if (strategy === 4) Object.assign(placement, { matched: text.slice(start, end), score });
    return placement;
  };

  const { quote } = anchor;
  if (quote) {
    // 1. Exact prefix + quote + suffix.
    const context = anchor.prefix + quote + anchor.suffix;
    const inContext = nearest(occurrences(text, context), lines, anchor.lines[0]);
    if (inContext !== undefined) {
      const start = inContext + anchor.prefix.length;
      return placeAt(1, start, start + quote.length);
    }
    // 2. Exact quote inside the same block.
    if (blockSpan) {
      const [from, to] = blockSpan;
      const inBlock = occurrences(text, quote).find((i) => i >= from && i + quote.length <= to);
      if (inBlock !== undefined) return placeAt(2, inBlock, inBlock + quote.length);
    }
    // 3. Unique exact quote anywhere.
    const anywhere = occurrences(text, quote);
    if (anywhere.length === 1) return placeAt(3, anywhere[0]!, anywhere[0]! + quote.length);
    // 4. Fuzzy quote, first inside the block, then anywhere (unambiguous only).
    const fuzzy =
      (blockSpan &&
        fuzzyFind(text, quote, {
          from: blockSpan[0],
          to: blockSpan[1],
          threshold: FUZZY_THRESHOLD,
        })) ||
      fuzzyFind(text, quote, { threshold: FUZZY_THRESHOLD, unique: true });
    if (fuzzy) return placeAt(4, fuzzy.start, fuzzy.end, fuzzy.score);
  }
  // 5. The block survives: attach to the whole block. 6. Otherwise the anchor is outdated.
  if (block) {
    return { revision, strategy: 5, block: block.id, lines: block.lines, matched: block.source };
  }
  return { revision, strategy: 6 };
}

/** Smallest block containing a line (blocks may nest, e.g. a paragraph inside a list). */
function blockAt(blocks: Block[], line: number): Block | undefined {
  let best: Block | undefined;
  for (const b of blocks) {
    if (b.lines[0] > line || b.lines[1] < line) continue;
    if (!best || b.lines[1] - b.lines[0] < best.lines[1] - best.lines[0]) best = b;
  }
  return best;
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) found.push(i);
  return found;
}

/** The occurrence whose line is closest to where the anchor used to be. */
function nearest(offsets: number[], lines: LineIndex, line: number): number | undefined {
  let best: number | undefined;
  let bestGap = Infinity;
  for (const offset of offsets) {
    const gap = Math.abs(lines.lineOf(offset) - line);
    if (gap < bestGap) [best, bestGap] = [offset, gap];
  }
  return best;
}

/** Maps between character offsets and 1-based line numbers. */
class LineIndex {
  private readonly starts: number[] = [0];

  constructor(private readonly text: string) {
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      this.starts.push(i + 1);
    }
  }

  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Lines covered by `[start, end)`. */
  rangeOf(start: number, end: number): LineRange {
    return [this.lineOf(start), this.lineOf(Math.max(start, end - 1))];
  }

  /** Character span `[from, to)` of a line range, without the final newline. */
  spanOf([first, last]: LineRange): [number, number] {
    const from = this.starts[first - 1] ?? this.text.length;
    const next = this.starts[last];
    return [from, next === undefined ? this.text.length : next - 1];
  }
}

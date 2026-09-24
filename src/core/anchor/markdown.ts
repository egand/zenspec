/**
 * Markdown anchors (plan §7): capture a W3C-style text selector, and re-anchor it
 * against a later revision with six strategies tried in order.
 */
import type { Block, BlockId, LineRange, MarkdownAnchor, Placement } from "../types.js";
import { fuzzyFind, normalizeWhitespace } from "./fuzzy.js";

/** Characters of context kept on each side of the quote. */
export const CONTEXT_CHARS = 32;
/** Minimal similarity for a fuzzy match (strategy 4). */
export const FUZZY_THRESHOLD = 0.8;
/**
 * Minimal share of the anchor's own context found in a block for strategy 5 to accept it.
 * Block IDs are ordinals within a section, so after a deletion another block inherits the ID.
 */
export const BLOCK_SIMILARITY_THRESHOLD = 0.5;
/** Below this many trigrams, the context alone is too short to vouch for a block. */
const MIN_CONTEXT_TRIGRAMS = 10;

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
    // An empty quote at the block start: the suffix fingerprints the block for strategy 5.
    const suffix = block.source.slice(0, CONTEXT_CHARS);
    return { ...base, quote: "", prefix: "", suffix, lines: block.lines };
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
  // 5. The block survives (same ID and still resembling the anchor's context): attach to the
  // whole block. 6. Otherwise the anchor is outdated.
  if (block && resembles(anchor, block.source)) {
    return { revision, strategy: 5, block: block.id, lines: block.lines, matched: block.source };
  }
  return { revision, strategy: 6 };
}

/**
 * Whether a block plausibly is the one the anchor was captured in: most character trigrams of
 * the anchor's own context (prefix and suffix cut at blank lines, so neighbouring blocks don't
 * count), or of that context plus the quote, still occur in the block. The quote alone is gone
 * by now (strategies 1-4 failed), so a rewritten quote in a surviving paragraph still matches.
 * An anchor without any context (e.g. a question's) always matches.
 */
function resembles(anchor: MarkdownAnchor, blockSource: string): boolean {
  const before = anchor.prefix.split(/\n\s*\n/).at(-1)!;
  const after = anchor.suffix.split(/\n\s*\n/)[0]!;
  const present = trigrams(blockSource);
  const share = (wanted: Set<string>): number => {
    let found = 0;
    for (const t of wanted) if (present.has(t)) found++;
    return found / wanted.size;
  };
  const context = trigrams(`${before}\n${after}`);
  const all = trigrams(before + anchor.quote + after);
  if (!all.size) return true;
  return (
    Math.max(context.size >= MIN_CONTEXT_TRIGRAMS ? share(context) : 0, share(all)) >=
    BLOCK_SIMILARITY_THRESHOLD
  );
}

function trigrams(text: string): Set<string> {
  const norm = normalizeWhitespace(text.toLowerCase()).text.trim();
  const out = new Set<string>();
  for (let i = 0; i + 3 <= norm.length; i++) out.add(norm.slice(i, i + 3));
  return out;
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

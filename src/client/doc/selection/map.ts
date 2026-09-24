/**
 * Maps text the reviewer selected in the rendered document back to character offsets in the
 * Markdown source, so the selection can become a §7 anchor (`createMarkdownAnchor`).
 *
 * The rendered text of a block is its mdast text leaves without markup. We rebuild that
 * projection from the block's node (whitespace dropped), remembering the source offset of every
 * character, then look the selected text up in it. Markup such as `**`, `[...](url)` or a
 * backslash escape never appears in the projection, so it is tolerated for free.
 */
import type { Nodes } from "mdast";
import type { LineRange } from "../../../core/types.js";

interface Projection {
  /** Non-whitespace rendered characters, in order. */
  text: string;
  /** Source offset of each character of `text`. */
  offsets: number[];
}

const WS = /\s/;
const FENCE = /^(?:`{3,}|~{3,})/;

/** Text leaves in rendering order. Math is skipped: KaTeX output doesn't match its TeX source. */
function leaves(node: Nodes, out: Nodes[] = []): Nodes[] {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
    if (!(node.type === "code" && node.lang === "mermaid")) out.push(node);
  } else if ("children" in node) {
    for (const child of node.children) leaves(child, out);
  }
  return out;
}

function project(source: string, node: Nodes): Projection {
  const chars: string[] = [];
  const offsets: number[] = [];
  for (const leaf of leaves(node)) {
    if (!("value" in leaf) || !leaf.position) continue;
    const from = leaf.position.start.offset!;
    const raw = source.slice(from, leaf.position.end.offset);
    // Skip a fence line so a value starting with `t` doesn't match the `ts` info string.
    let j = leaf.type === "code" && FENCE.test(raw) ? raw.indexOf("\n") + 1 : 0;
    for (const c of leaf.value) {
      if (WS.test(c)) continue;
      const k = raw.indexOf(c, j);
      if (k < 0) break;
      chars.push(c);
      offsets.push(from + k);
      j = k + 1;
    }
  }
  return { text: chars.join(""), offsets };
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    found.push(i);
  }
  return found;
}

/**
 * Finds `quote` (rendered text) inside `node` and returns its source span, end exclusive.
 * `hint` is the number of non-whitespace rendered characters before the selection in the
 * block; it picks the right occurrence when the quote repeats. Returns null when the quote
 * can't be located (e.g. it spans rendered math).
 */
export function mapSelection(
  source: string,
  node: Nodes,
  quote: string,
  hint = 0,
): { start: number; end: number } | null {
  const needle = quote.replace(/\s+/g, "");
  if (!needle) return null;
  const { text, offsets } = project(source, node);
  const hits = occurrences(text, needle);
  if (!hits.length) return null;
  const at = hits.reduce((best, i) => (Math.abs(i - hint) < Math.abs(best - hint) ? i : best));
  return { start: offsets[at]!, end: offsets[at + needle.length - 1]! + 1 };
}

/** 1-based inclusive line range covered by `[start, end)` in `source`. */
export function linesOf(source: string, start: number, end: number): LineRange {
  const lineAt = (offset: number): number => {
    let line = 1;
    for (let i = source.indexOf("\n"); i >= 0 && i < offset; i = source.indexOf("\n", i + 1)) {
      line++;
    }
    return line;
  };
  return [lineAt(start), lineAt(Math.max(start, end - 1))];
}

/** Rendered text of a DOM fragment, without UI chrome (`data-zen-ui`) or rendered math. */
export function visibleText(fragment: DocumentFragment): string {
  for (const el of fragment.querySelectorAll("[data-zen-ui], .katex, .zen-mermaid")) el.remove();
  return fragment.textContent ?? "";
}

/** Non-whitespace rendered characters in `block` before the start of `range`. */
export function renderedOffset(block: Element, range: Range): number {
  const before = block.ownerDocument.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  return visibleText(before.cloneContents()).replace(/\s+/g, "").length;
}

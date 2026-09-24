/** Turns a selection reported by the document view into an anchor (plan §7, §12). */
import { CONTEXT_CHARS } from "../../core/anchor.js";
import type { Anchor, Block, HtmlAnchor, MarkdownAnchor } from "../../core/types.js";

export type TextSelectionInfo = {
  blockId: string;
  quote: string;
  start: number;
  end: number;
  lines: [number, number];
};
export type HtmlSelectionInfo = { html: { cssPath: string; tag: string; textQuote: string } };
export type SelectionInfo = TextSelectionInfo | HtmlSelectionInfo;

export function isHtmlSelection(sel: SelectionInfo): sel is HtmlSelectionInfo {
  return "html" in sel;
}

/** The quote shown to the reviewer for a selection. */
export function selectionQuote(sel: SelectionInfo): string {
  return isHtmlSelection(sel) ? sel.html.textQuote : sel.quote;
}

/** Offset of the first character of `line` (1-based) in `text`. */
function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}

/**
 * Where the quote sits in the source. `start`/`end` are trusted when they point at the quote;
 * otherwise they are read as block-relative, and failing that the quote is searched from the
 * first selected line.
 */
function locate(source: string, sel: TextSelectionInfo, blocks: readonly Block[]) {
  const { quote, start, end } = sel;
  if (source.slice(start, end) === quote) return start;
  const block = blocks.find((b) => b.id === sel.blockId);
  if (block) {
    const base = lineOffset(source, block.lines[0]);
    if (source.slice(base + start, base + end) === quote) return base + start;
  }
  const from = source.indexOf(quote, lineOffset(source, sel.lines[0]));
  return from >= 0 ? from : source.indexOf(quote);
}

export function markdownAnchor(
  source: string,
  sel: TextSelectionInfo,
  revision: number,
  blocks: readonly Block[],
): MarkdownAnchor {
  const at = sel.quote ? locate(source, sel, blocks) : -1;
  const found = at >= 0;
  return {
    type: "markdown",
    rev: revision,
    block: sel.blockId,
    quote: sel.quote,
    prefix: found ? source.slice(Math.max(0, at - CONTEXT_CHARS), at) : "",
    suffix: found ? source.slice(at + sel.quote.length, at + sel.quote.length + CONTEXT_CHARS) : "",
    lines: sel.lines,
  };
}

export function anchorFor(
  source: string,
  sel: SelectionInfo,
  revision: number,
  blocks: readonly Block[],
): Anchor {
  if (isHtmlSelection(sel)) {
    const anchor: HtmlAnchor = { type: "html", rev: revision, ...sel.html };
    return anchor;
  }
  return markdownAnchor(source, sel, revision, blocks);
}

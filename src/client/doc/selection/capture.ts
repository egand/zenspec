/** Turns the browser selection (or a whole block) into a `MarkdownSelection` without the action. */
import type { ParsedBlock, ParsedMarkdown } from "../../../core/types.js";
import type { MarkdownSelection } from "../types.js";
import { linesOf, mapSelection, renderedOffset, visibleText } from "./map.js";

export type PendingText = Omit<MarkdownSelection, "action">;

function span(block: ParsedBlock): { start: number; end: number } {
  return { start: block.node.position!.start.offset!, end: block.node.position!.end.offset! };
}

function toSelection(source: string, block: ParsedBlock, start: number, end: number): PendingText {
  return {
    blockId: block.id,
    quote: source.slice(start, end),
    start,
    end,
    lines: linesOf(source, start, end),
  };
}

export function wholeBlock(
  source: string,
  doc: ParsedMarkdown,
  blockId: string,
): PendingText | null {
  const block = doc.blocks.find((b) => b.id === blockId);
  if (!block) return null;
  const { start, end } = span(block);
  return toSelection(source, block, start, end);
}

const blockOf = (node: Node): HTMLElement | null =>
  (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>(
    "[data-block-id]",
  ) ?? null;

/**
 * The current selection inside `body`, if it starts and ends in the same block. Falls back to
 * the whole block when the rendered text can't be located in the source (e.g. across math).
 */
export function captureSelection(
  body: HTMLElement,
  source: string,
  doc: ParsedMarkdown,
): { sel: PendingText; range: Range } | null {
  const selection = body.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const el = blockOf(range.startContainer);
  if (!el || el !== blockOf(range.endContainer) || !body.contains(el)) return null;
  const start = range.startContainer;
  const host = start.nodeType === 1 ? (start as Element) : start.parentElement;
  if (host?.closest("[data-zen-ui], input, textarea, button")) return null;

  const block = doc.blocks.find((b) => b.id === el.dataset.blockId);
  if (!block) return null;
  const quote = visibleText(range.cloneContents());
  if (!quote.trim()) return null;
  const hit = mapSelection(source, block.node, quote, renderedOffset(el, range)) ?? span(block);
  return { sel: toSelection(source, block, hit.start, hit.end), range };
}

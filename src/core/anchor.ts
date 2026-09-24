/**
 * Anchoring engine (plan §7, §9.1, §12). Pure: callers pass the new revision's content.
 */
import type { Anchor, DraftThread, Placement, Thread, ThreadId, ThreadSpec } from "./types.js";
import { reanchorHtml, type HtmlSnapshot } from "./anchor/html.js";
import { reanchorMarkdown, type MarkdownSnapshot } from "./anchor/markdown.js";

export { normalizeWhitespace, fuzzyFind, type FuzzyMatch } from "./anchor/fuzzy.js";
export {
  CONTEXT_CHARS,
  FUZZY_THRESHOLD,
  createMarkdownAnchor,
  reanchorMarkdown,
  type MarkdownSnapshot,
  type TextSelection,
} from "./anchor/markdown.js";
export { reanchorHtml, type HtmlElement, type HtmlSnapshot } from "./anchor/html.js";

/** The content an anchor is re-anchored against. */
export type Snapshot = MarkdownSnapshot | HtmlSnapshot;

/** Re-anchors one anchor. An anchor of the wrong document kind is outdated. */
export function reanchor(anchor: Anchor, doc: Snapshot): Placement {
  if (anchor.type === "markdown" && doc.kind === "markdown") return reanchorMarkdown(anchor, doc);
  if (anchor.type === "html" && doc.kind === "html") return reanchorHtml(anchor, doc);
  return { revision: doc.revision, strategy: 6 };
}

function anchorOf(spec: ThreadSpec): Anchor | undefined {
  return spec.kind === "general" ? undefined : spec.anchor;
}

/**
 * Placements for every anchored thread that is not resolved, for `revision_published.placements`
 * when a revision is published. Strategy 6 is what moves an open thread to `outdated`.
 */
export function reanchorThreads(
  threads: Iterable<Thread>,
  doc: Snapshot,
): Record<ThreadId, Placement> {
  const placements: Record<ThreadId, Placement> = {};
  for (const thread of threads) {
    const anchor = anchorOf(thread);
    if (anchor && thread.status !== "resolved") placements[thread.id] = reanchor(anchor, doc);
  }
  return placements;
}

/**
 * Re-anchors draft items against the current content (§9.1). Items whose target
 * disappeared are marked `orphaned` and keep their original anchor and quote.
 */
export function reanchorDraft(items: readonly DraftThread[], doc: Snapshot): DraftThread[] {
  return items.map((item) => {
    const anchor = anchorOf(item);
    if (!anchor) return item;
    const placement = reanchor(anchor, doc);
    return { ...item, placement, orphaned: placement.strategy === 6 || undefined };
  });
}

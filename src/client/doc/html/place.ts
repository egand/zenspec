/**
 * Client-side re-anchoring of HTML threads (§12). The daemon has no DOM, so it cannot re-anchor
 * HTML anchors when a revision is published. Instead, each time the mockup loads, the iframe's
 * picker script reports every element as `{ cssPath, tag, text }`, and the placements are
 * computed here with the core `reanchorHtml`.
 *
 * Best effort and display only: the result outlines elements in the iframe but is never stored,
 * never changes a thread's status, and never reaches the agent payload. Threads whose element
 * is gone (strategy 6) are simply not outlined.
 */
import { reanchorHtml, type HtmlElement } from "../../../core/anchor.js";
import type { DocHighlight } from "../types.js";

export interface PlacedHtmlHighlight {
  threadId: string;
  cssPath: string;
  status: DocHighlight["status"];
  active?: boolean;
}

/**
 * Where each HTML highlight lands in the shown page. `elements` is `null` until the page has
 * reported them; the anchors' original CSS paths are used meanwhile.
 */
export function placeHtmlHighlights(
  highlights: readonly DocHighlight[],
  elements: readonly HtmlElement[] | null,
): PlacedHtmlHighlight[] {
  return highlights.flatMap(({ threadId, status, active, htmlAnchor }) => {
    if (!htmlAnchor) return [];
    const cssPath = elements
      ? reanchorHtml(htmlAnchor, {
          kind: "html",
          revision: htmlAnchor.rev,
          elements: [...elements],
        }).cssPath
      : htmlAnchor.cssPath;
    return cssPath ? [{ threadId, cssPath, status, ...(active && { active }) }] : [];
  });
}

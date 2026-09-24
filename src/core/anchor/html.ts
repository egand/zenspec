/**
 * HTML mockup anchors (plan §12), re-anchored against a DOM-free element list:
 * the text quote among elements of the same tag (strategy 2), then the CSS path
 * (strategy 3), otherwise outdated (strategy 6).
 */
import type { HtmlAnchor, Placement } from "../types.js";

/** An element of an HTML revision, as extracted by whoever owns the DOM. */
export interface HtmlElement {
  cssPath: string;
  tag: string;
  /** The element's text content. */
  text: string;
}

export interface HtmlSnapshot {
  kind: "html";
  revision: number;
  elements: HtmlElement[];
}

export function reanchorHtml(anchor: HtmlAnchor, doc: HtmlSnapshot): Placement {
  const tag = anchor.tag.toLowerCase();
  const sameTag = doc.elements.filter((e) => e.tag.toLowerCase() === tag);
  const quote = squash(anchor.textQuote);
  if (quote) {
    // Prefer an element whose whole text is the quote, then one containing it;
    // on ties, the element that kept its CSS path.
    const exact = sameTag.filter((e) => squash(e.text) === quote);
    const candidates = exact.length ? exact : sameTag.filter((e) => squash(e.text).includes(quote));
    const hit = candidates.find((e) => e.cssPath === anchor.cssPath) ?? candidates[0];
    if (hit) return placed(doc.revision, 2, hit);
  }
  const byPath = sameTag.find((e) => e.cssPath === anchor.cssPath);
  if (byPath) return placed(doc.revision, 3, byPath);
  return { revision: doc.revision, strategy: 6 };
}

function placed(revision: number, strategy: 2 | 3, element: HtmlElement): Placement {
  return { revision, strategy, cssPath: element.cssPath, matched: element.text };
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

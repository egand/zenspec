/**
 * HTML safety helpers shared by the browser doc view and the standalone export, so both apply
 * the same rules. Pure: no DOM.
 */

/** URLs kept in links and images: http(s), mailto, fragments, and relative paths. */
export const SAFE_URL = /^(?:https?:|mailto:|#|\/|\.|[^:]*$)/i;

/** The URL when it is safe to render, otherwise `undefined` (the link or image is dropped). */
export const safeUrl = (url: string): string | undefined => (SAFE_URL.test(url) ? url : undefined);

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for HTML content and double-quoted attributes. */
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

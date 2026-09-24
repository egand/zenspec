/**
 * Script injected into an HTML mockup (§12). The iframe is sandboxed without same-origin, so it
 * talks to the parent only through postMessage:
 *   → parent  { zen: "pick", cssPath, tag, textQuote, rect }
 *   → parent  { zen: "thread", threadId }  (a highlighted element was clicked; Alt-click picks)
 *   ← parent  { zen: "highlights", items: [{ threadId, cssPath, status, active }] }
 * Written as a plain function and serialized, so it has no imports and no closures.
 */
function pickerMain(): void {
  const QUOTE_MAX = 120;
  const style = document.createElement("style");
  style.textContent = `
    [data-zen-hover] { outline: 2px dashed #3b82f6 !important; outline-offset: 2px; cursor: crosshair !important; }
    [data-zen-thread] { outline: 2px solid #d29922 !important; outline-offset: 2px; }
    [data-zen-thread][data-zen-status="resolved"] { outline-color: #2ea043 !important; }
    [data-zen-thread][data-zen-active] { outline-width: 3px !important; outline-color: #3b82f6 !important; }
  `;
  document.head.appendChild(style);

  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (
      let node: Element | null = el;
      node && node !== document.documentElement;
      node = node.parentElement
    ) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      const same = parent
        ? Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
        : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
    }
    return parts.join(" > ");
  };

  let hovered: Element | null = null;
  document.addEventListener("mouseover", (e) => {
    hovered?.removeAttribute("data-zen-hover");
    hovered = e.target instanceof Element && e.target !== document.body ? e.target : null;
    hovered?.setAttribute("data-zen-hover", "");
  });
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || el === document.body || el === document.documentElement) return;
      e.preventDefault();
      e.stopPropagation();
      // A highlighted element opens its thread; Alt-click comments on it again.
      const thread = el.closest("[data-zen-thread]");
      if (thread && !e.altKey) {
        parent.postMessage(
          { zen: "thread", threadId: thread.getAttribute("data-zen-thread") },
          "*",
        );
        return;
      }
      const r = el.getBoundingClientRect();
      parent.postMessage(
        {
          zen: "pick",
          cssPath: cssPath(el),
          tag: el.tagName.toLowerCase(),
          textQuote: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, QUOTE_MAX),
          rect: { top: r.top, left: r.left, width: r.width, height: r.height },
        },
        "*",
      );
    },
    true,
  );
  window.addEventListener("message", (e) => {
    if (e.source !== parent || e.data?.zen !== "highlights") return;
    for (const el of document.querySelectorAll("[data-zen-thread]")) {
      el.removeAttribute("data-zen-thread");
      el.removeAttribute("data-zen-status");
      el.removeAttribute("data-zen-active");
    }
    for (const item of e.data.items as {
      threadId: string;
      cssPath: string;
      status: string;
      active?: boolean;
    }[]) {
      let el: Element | null = null;
      try {
        el = document.querySelector(item.cssPath);
      } catch {
        el = null;
      }
      if (!el) continue;
      el.setAttribute("data-zen-thread", item.threadId);
      el.setAttribute("data-zen-status", item.status);
      if (item.active) el.setAttribute("data-zen-active", "");
    }
  });
  parent.postMessage({ zen: "ready" }, "*");
}

export const PICKER_SCRIPT = `<script>(${pickerMain.toString()})();</script>`;

/** The mockup with the picker appended (before `</body>` when present). */
export function withPicker(html: string): string {
  const at = html.search(/<\/body\s*>/i);
  return at < 0 ? html + PICKER_SCRIPT : html.slice(0, at) + PICKER_SCRIPT + html.slice(at);
}

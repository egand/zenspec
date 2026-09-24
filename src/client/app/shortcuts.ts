/**
 * Keyboard shortcuts: `c` comment on the selection, `a` submit with Approve, `Esc` close.
 * `z` (focus mode) belongs to the document view. Nothing fires while typing.
 */
import { useEffect } from "preact/hooks";
import { mapSelection } from "../doc/selection/map.js";
import type { AppContextValue } from "./actions.js";
import { closeTop } from "./ui.js";
import type { TextSelectionInfo } from "../store/selection.js";

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = source.indexOf("\n"); i >= 0 && i < offset; i = source.indexOf("\n", i + 1)) line++;
  return line;
}

/** The current DOM selection inside one rendered Markdown block, mapped to the source. */
export function currentSelection({ store }: AppContextValue): TextSelectionInfo | null {
  const selection = globalThis.getSelection?.();
  const text = selection?.toString().trim();
  if (!selection || !text || !selection.rangeCount) return null;
  const container = selection.getRangeAt(0).commonAncestorContainer;
  const el = container instanceof Element ? container : container.parentElement;
  const blockId = el?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
  const block = store.parsed.value?.blocks.find((b) => b.id === blockId);
  if (!blockId || !block) return null;
  const source = store.source.value;
  const span = mapSelection(source, block.node, text);
  if (!span) return { blockId, quote: "", start: 0, end: 0, lines: block.lines };
  return {
    blockId,
    quote: source.slice(span.start, span.end),
    start: span.start,
    end: span.end,
    lines: [lineAt(source, span.start), lineAt(source, span.end - 1)],
  };
}

export function handleShortcut(e: KeyboardEvent, app: AppContextValue): boolean {
  const { ui, actions } = app;
  if (e.key === "Escape") return closeTop(ui);
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return false;
  if (ui.composer.value || ui.submit.value || ui.lightbox.value) return false;
  if (e.key === "c") {
    const selection = currentSelection(app);
    if (selection) actions.select({ ...selection, action: "comment" });
    else ui.composer.value = { mode: "general" };
    return true;
  }
  if (e.key === "a") {
    if (!app.store.latest.value) return false;
    actions.openSubmit("approved");
    return true;
  }
  return false;
}

export function useShortcuts(app: AppContextValue): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleShortcut(e, app)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app]);
}

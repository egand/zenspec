import { signal } from "@preact/signals";
import { createContext } from "preact";
import type { Choice, QuestionId } from "../../core/types.js";

/**
 * Stable callbacks shared by every block. The value never changes identity, so memoized blocks
 * don't re-render when the parent's props (and their closures) change.
 */
export interface DocActions {
  answer(questionId: QuestionId, choice: Choice | null, note?: string): void;
  dismissTerm(term: string): void;
  selectBlock(blockId: string, anchor: Element): void;
}

const noop = (): void => {};
export const DocActionsContext = createContext<DocActions>({
  answer: noop,
  dismissTerm: noop,
  selectBlock: noop,
});

const readDark = (): boolean =>
  typeof document === "undefined" || document.documentElement.dataset.theme !== "light";

/** Dark unless `<html data-theme="light">` (the legacy convention). Only diagrams read it. */
export const isDark = signal(readDark());

if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
  new MutationObserver(() => {
    isDark.value = readDark();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

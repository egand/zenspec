/** UI-only state of the document page: panels, dialogs, focus. Never persisted. */
import { signal } from "@preact/signals";
import type { Verdict } from "../../core/types.js";
import type { SelectionInfo } from "../store/selection.js";

export type PanelTab = "draft" | "threads" | "revisions";

export type ComposerState =
  | { mode: "comment" | "suggest" | "explain"; selection: SelectionInfo }
  | { mode: "general" }
  | { mode: "edit"; draftId: string }
  | { mode: "reply"; threadId: string };

export interface SubmitState {
  verdict: Verdict;
}

export interface Compare {
  from: number;
  to: number;
}

export function createUi() {
  return {
    tab: signal<PanelTab>("draft"),
    composer: signal<ComposerState | null>(null),
    submit: signal<SubmitState | null>(null),
    lightbox: signal<string | null>(null),
    /** Thread or draft item selected in the panel or the document. */
    active: signal<string | null>(null),
    focus: signal<{ threadId?: string; lines?: [number, number]; nonce: number } | undefined>(
      undefined,
    ),
    compare: signal<Compare | null>(null),
  };
}

export type Ui = ReturnType<typeof createUi>;

export function focusOn(ui: Ui, threadId: string, lines?: [number, number]): void {
  ui.active.value = threadId;
  ui.focus.value = { threadId, ...(lines && { lines }), nonce: (ui.focus.value?.nonce ?? 0) + 1 };
}

/** Closes the topmost overlay. Returns whether something was closed. */
export function closeTop(ui: Ui): boolean {
  if (ui.lightbox.value) ui.lightbox.value = null;
  else if (ui.composer.value) ui.composer.value = null;
  else if (ui.submit.value) ui.submit.value = null;
  else return false;
  return true;
}

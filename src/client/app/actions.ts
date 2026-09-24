/** Reviewer actions: each one updates the draft (saved by the store) or opens a UI surface. */
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type {
  AttachmentRef,
  Choice,
  QuestionId,
  ThreadId,
  ThreadSpec,
  Verdict,
} from "../../core/types.js";
import type { DocStore } from "../store/doc-store.js";
import * as drafts from "../store/draft.js";
import {
  anchorFor,
  isHtmlSelection,
  selectionQuote,
  type SelectionInfo,
} from "../store/selection.js";
import { focusOn, type Ui } from "./ui.js";

export type SelectAction = "comment" | "suggest" | "explain";

export function createActions(store: DocStore, ui: Ui) {
  const revision = () => store.latest.value?.n ?? 0;
  const blocks = () => store.parsed.value?.blocks ?? [];

  const actions = {
    /** From the document view's selection toolbar. */
    select(sel: SelectionInfo & { action: SelectAction }) {
      const { action, ...selection } = sel;
      const mode = action === "suggest" && isHtmlSelection(selection) ? "comment" : action;
      ui.composer.value = { mode, selection };
    },

    /** Builds the thread spec for a selection-based composer. */
    specFor(
      mode: SelectAction,
      selection: SelectionInfo,
      fields: { new?: string; term?: string },
    ): ThreadSpec {
      const anchor = anchorFor(store.source.value, selection, revision(), blocks());
      if (mode === "suggest" && anchor.type === "markdown") {
        return { kind: "suggestion", anchor, old: anchor.quote, new: fields.new ?? anchor.quote };
      }
      if (mode === "explain") {
        return { kind: "explain", anchor, term: fields.term?.trim() || selectionQuote(selection) };
      }
      return { kind: "comment", anchor };
    },

    addThread(spec: ThreadSpec, body: string, attachments: AttachmentRef[] = []) {
      store.updateDraft((d) => drafts.addThread(d, spec, body, attachments));
      ui.tab.value = "draft";
    },

    general(body: string, attachments: AttachmentRef[] = []) {
      actions.addThread({ kind: "general" }, body, attachments);
    },

    editDraftItem(
      draftId: string,
      patch: { body?: string; attachments?: AttachmentRef[]; new?: string; term?: string },
    ) {
      store.updateDraft((d) => drafts.updateThread(d, draftId, patch));
    },

    removeDraftItem(draftId: string) {
      store.updateDraft((d) => drafts.removeThread(d, draftId));
    },

    /** From the document view's question blocks. Never called with the recommended option by us. */
    answer(questionId: QuestionId, choice: Choice | null, note?: string) {
      const question = store.questions.value.find((q) => q.id === questionId);
      if (!question) return;
      store.updateDraft((d) => drafts.setAnswer(d, question, choice, note));
    },

    acceptRecommended(questionIds: QuestionId[]) {
      const wanted = new Set(questionIds);
      const questions = store.questions.value.filter((q) => wanted.has(q.id));
      store.updateDraft((d) => drafts.acceptRecommended(d, questions));
    },

    resolve(id: ThreadId) {
      store.updateDraft((d) => drafts.stageResolve(d, id));
    },

    reopen(id: ThreadId, body: string, attachments: AttachmentRef[] = []) {
      store.updateDraft((d) => drafts.stageReopen(d, id, body, attachments));
    },

    unstage(id: ThreadId) {
      store.updateDraft((d) => drafts.unstage(d, id));
    },

    setVerdict(verdict: Verdict, summary?: string) {
      store.updateDraft((d) => ({ ...d, verdict, ...(summary !== undefined && { summary }) }));
    },

    openSubmit(verdict?: Verdict) {
      ui.submit.value = { verdict: verdict ?? store.draft.value?.verdict ?? "comment" };
    },

    focusThread(id: string) {
      const thread = store.state.value.threads[id];
      const item = store.draft.value?.threads.find((t) => t.draftId === id);
      const target = thread ?? item;
      const lines =
        target?.placement?.lines ??
        (target && target.kind !== "general" && target.anchor.type === "markdown"
          ? target.anchor.lines
          : undefined);
      focusOn(ui, id, lines);
    },

    /** A highlight in the document was clicked: show its card in the panel. */
    highlightClicked(id: string) {
      ui.tab.value = store.state.value.threads[id] ? "threads" : "draft";
      ui.active.value = id;
    },
  };
  return actions;
}

export type Actions = ReturnType<typeof createActions>;

export interface AppContextValue {
  store: DocStore;
  ui: Ui;
  actions: Actions;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("AppContext is missing");
  return value;
}

/** Modal for a new draft item: comment, suggestion, explain, general note, edit, or reply. */
import { useState } from "preact/hooks";
import type { DraftThread } from "../../core/types.js";
import { useApp } from "../app/actions.js";
import type { ComposerState } from "../app/ui.js";
import { selectionQuote } from "../store/selection.js";
import { quoteOf } from "../store/view.js";
import { RichField, useImageDrop } from "./Attachments.js";
import { Modal } from "./Modal.js";
import { wordDiff } from "./word-diff.js";

const TITLES = {
  comment: "Comment",
  suggest: "Suggest an edit",
  explain: "Ask for an explanation",
  general: "General comment",
  edit: "Edit draft item",
  reply: "Reply",
} as const;

export function Composer() {
  const { ui } = useApp();
  const state = ui.composer.value;
  if (!state) return null;
  // Keyed so each opening starts from fresh state.
  return <ComposerForm key={JSON.stringify(state)} state={state} />;
}

function ComposerForm({ state }: { state: ComposerState }) {
  const { store, ui, actions } = useApp();
  const editing: DraftThread | undefined =
    state.mode === "edit"
      ? store.draft.value?.threads.find((t) => t.draftId === state.draftId)
      : undefined;
  const quote =
    "selection" in state ? selectionQuote(state.selection) : editing ? quoteOf(editing) : "";
  const kind = state.mode === "edit" ? editing?.kind : state.mode;

  const [body, setBody] = useState(editing?.body ?? "");
  const [next, setNext] = useState(editing?.kind === "suggestion" ? editing.new : quote);
  const [term, setTerm] = useState(editing?.kind === "explain" ? editing.term : quote);
  const images = useImageDrop(editing?.attachments ?? []);

  const isSuggestion = kind === "suggest" || kind === "suggestion";
  const isExplain = kind === "explain";
  const canSave =
    images.uploading === 0 &&
    (isSuggestion
      ? next !== quote || body.trim() !== ""
      : isExplain
        ? term.trim() !== ""
        : body.trim() !== "" || images.attachments.length > 0);

  const close = () => (ui.composer.value = null);
  const save = () => {
    if (!canSave) return;
    const { attachments } = images;
    switch (state.mode) {
      case "comment":
      case "suggest":
      case "explain":
        actions.addThread(
          actions.specFor(state.mode, state.selection, { new: next, term }),
          body.trim(),
          attachments,
        );
        break;
      case "general":
        actions.general(body.trim(), attachments);
        break;
      case "edit":
        actions.editDraftItem(state.draftId, {
          body: body.trim(),
          attachments,
          ...(isSuggestion && { new: next }),
          ...(isExplain && { term: term.trim() }),
        });
        break;
      case "reply":
        actions.reopen(state.threadId, body.trim(), attachments);
        break;
    }
    close();
  };

  return (
    <Modal title={TITLES[state.mode]} onClose={close} onSubmit={save}>
      {quote && !isSuggestion && <blockquote class="zen-quote">{quote}</blockquote>}
      {isExplain && (
        <label class="zen-label">
          Term
          <input
            class="zen-input"
            value={term}
            onInput={(e) => setTerm((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
      )}
      {isSuggestion && (
        <>
          <div class="zen-label">Current text</div>
          <pre class="zen-suggest-old">{quote}</pre>
          <label class="zen-label">
            Replace with
            <textarea
              class="zen-textarea zen-mono"
              rows={3}
              value={next}
              autoFocus
              onInput={(e) => setNext((e.currentTarget as HTMLTextAreaElement).value)}
            />
          </label>
          <div class="zen-label">Preview</div>
          <WordDiffView oldText={quote} newText={next} />
        </>
      )}
      <RichField
        value={body}
        onInput={setBody}
        images={images}
        autoFocus={!isSuggestion}
        rows={isSuggestion ? 2 : 4}
        placeholder={
          isExplain
            ? "What would you like to know? (optional)"
            : isSuggestion
              ? "Why? (optional)"
              : state.mode === "reply"
                ? "Your reply reopens the thread"
                : "Leave a comment"
        }
      />
      <div class="zen-modal-actions">
        <span class="zen-kbd-hint">⌘↵ to save · Esc to cancel</span>
        <button type="button" class="zen-btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" class="zen-btn zen-btn-primary" disabled={!canSave}>
          {state.mode === "edit"
            ? "Save"
            : state.mode === "reply"
              ? "Stage reply"
              : "Add to review"}
        </button>
      </div>
    </Modal>
  );
}

export function WordDiffView({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <div class="zen-word-diff">
      {wordDiff(oldText, newText).map((c, i) =>
        c.op === "equal" ? (
          <span key={i}>{c.text}</span>
        ) : c.op === "delete" ? (
          <del key={i}>{c.text}</del>
        ) : (
          <ins key={i}>{c.text}</ins>
        ),
      )}
    </div>
  );
}

/** The pending review: new items, staged thread actions, and the submit button. */
import type { DraftThread } from "../../core/types.js";
import { useApp } from "../app/actions.js";
import { describeChoice, isOrphaned, quoteOf } from "../store/view.js";
import { Thumbnails } from "./Attachments.js";
import { WordDiffView } from "./Composer.js";
import { useScrollWhenActive } from "./hooks.js";

const KIND_LABEL = {
  comment: "Comment",
  suggestion: "Suggestion",
  decision: "Answer",
  explain: "Explain",
  general: "General",
} as const;

export function DraftTab() {
  const { store, ui, actions } = useApp();
  const draft = store.draft.value;
  const items = draft?.threads ?? [];
  const staged = [
    ...(draft?.reopen.map((r) => ({ id: r.thread, action: "reopen" as const, body: r.body })) ??
      []),
    ...(draft?.resolve.map((id) => ({ id, action: "resolve" as const, body: "" })) ?? []),
  ];
  const empty = !items.length && !staged.length;

  return (
    <div class="zen-tab-pane">
      <div class="zen-scroll">
        {empty && (
          <p class="zen-empty">
            Nothing pending. Select text in the document to comment, suggest an edit, or ask for an
            explanation.
          </p>
        )}
        {items.map((item) => (
          <DraftItem key={item.draftId} item={item} />
        ))}
        {staged.length > 0 && <h3 class="zen-section-title">Thread actions</h3>}
        {staged.map((s) => (
          <div class="zen-card" key={`${s.action}-${s.id}`}>
            <div class="zen-card-head">
              <span class={`zen-tag zen-tag-${s.action}`}>
                {s.action === "resolve" ? "Resolve" : "Reopen"}
              </span>
              <button type="button" class="zen-link" onClick={() => actions.focusThread(s.id)}>
                {s.id}
              </button>
              <span class="zen-spacer" />
              <button type="button" class="zen-btn-sm" onClick={() => actions.unstage(s.id)}>
                Undo
              </button>
            </div>
            {s.body && <p class="zen-body">{s.body}</p>}
          </div>
        ))}
      </div>
      <footer class="zen-panel-footer">
        <button
          type="button"
          class="zen-btn"
          onClick={() => (ui.composer.value = { mode: "general" })}
        >
          General comment
        </button>
        <span class="zen-save-status">{saveLabel(store.saveStatus.value)}</span>
        <button
          type="button"
          class="zen-btn zen-btn-primary"
          disabled={!store.latest.value}
          onClick={() => actions.openSubmit()}
        >
          Submit review
        </button>
      </footer>
    </div>
  );
}

function saveLabel(status: string): string {
  switch (status) {
    case "pending":
    case "saving":
      return "Saving…";
    case "error":
      return "Not saved, retrying";
    default:
      return "Saved";
  }
}

function DraftItem({ item }: { item: DraftThread }) {
  const { store, ui, actions } = useApp();
  const questions = store.parsed.value ? store.questions.value : null;
  const orphaned = isOrphaned(item, questions);
  const quote = quoteOf(item);
  const question =
    item.kind === "decision"
      ? store.questions.value.find((q) => q.id === item.question)
      : undefined;
  const active = ui.active.value === item.draftId;
  const ref = useScrollWhenActive<HTMLDivElement>(active);

  return (
    <div
      class={`zen-card${active ? " active" : ""}${orphaned ? " orphaned" : ""}`}
      data-id={item.draftId}
      ref={ref}
    >
      <div class="zen-card-head">
        <span class={`zen-tag zen-tag-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        {orphaned && (
          <span class="zen-tag zen-tag-orphaned" title="The text or question it refers to is gone">
            Orphaned
          </span>
        )}
        <span class="zen-spacer" />
        {!orphaned && item.kind !== "general" && (
          <button
            type="button"
            class="zen-btn-sm"
            onClick={() => actions.focusThread(item.draftId)}
          >
            Show
          </button>
        )}
        {item.kind !== "decision" && (
          <button
            type="button"
            class="zen-btn-sm"
            onClick={() => (ui.composer.value = { mode: "edit", draftId: item.draftId })}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          class="zen-btn-sm"
          onClick={() => actions.removeDraftItem(item.draftId)}
        >
          Discard
        </button>
      </div>
      {item.kind === "decision" && (
        <p class="zen-body">
          <span class="zen-muted">{question?.title ?? item.question} →</span>{" "}
          <strong>{describeChoice(item.choice)}</strong>
        </p>
      )}
      {item.kind === "suggestion" ? (
        <WordDiffView oldText={item.old} newText={item.new} />
      ) : (
        quote && <blockquote class="zen-quote">{quote}</blockquote>
      )}
      {item.kind === "explain" && (
        <p class="zen-body">
          Explain <strong>{item.term}</strong>
        </p>
      )}
      {item.body && <p class="zen-body">{item.body}</p>}
      <Thumbnails attachments={item.attachments} />
    </div>
  );
}

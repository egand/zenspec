/** Submit review (plan §9, §9.1): verdict, summary, and a single prompt about unanswered questions. */
import { useState } from "preact/hooks";
import type { Question, Verdict } from "../../core/types.js";
import { useApp } from "../app/actions.js";
import { RequestError } from "../store/api.js";
import { unansweredQuestions } from "../store/draft.js";
import { Modal } from "./Modal.js";

const VERDICTS: { value: Verdict; label: string; hint: string }[] = [
  { value: "comment", label: "Comment", hint: "Feedback without a decision" },
  { value: "changes_requested", label: "Request changes", hint: "The agent must revise" },
  { value: "approved", label: "Approve", hint: "Good to implement" },
];

export function SubmitDialog() {
  const { ui } = useApp();
  const state = ui.submit.value;
  if (!state) return null;
  return <SubmitForm initialVerdict={state.verdict} />;
}

function SubmitForm({ initialVerdict }: { initialVerdict: Verdict }) {
  const { store, ui, actions } = useApp();
  const draft = store.draft.value;
  const [verdict, setVerdict] = useState<Verdict>(initialVerdict);
  const [summary, setSummary] = useState(draft?.summary ?? "");
  const [pendingQuestions, setPendingQuestions] = useState<Question[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts = {
    items: draft?.threads.length ?? 0,
    reopen: draft?.reopen.length ?? 0,
    replies: draft?.replies.length ?? 0,
    resolve: draft?.resolve.length ?? 0,
  };
  const close = () => (ui.submit.value = null);
  const remember = (v: Verdict, s: string) => actions.setVerdict(v, s);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await store.submit(verdict, summary.trim());
      close();
      ui.tab.value = "threads";
    } catch (err) {
      const stale = err instanceof RequestError && err.code === "conflict";
      setError(
        stale
          ? `${(err as Error).message}. Review the new revision first.`
          : (err as Error).message,
      );
      setPendingQuestions(null);
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = () => {
    if (busy) return;
    if (pendingQuestions) return;
    const open = unansweredQuestions(store.questions.value, store.draft.value, store.threads.value);
    if (open.length) setPendingQuestions(open);
    else void send();
  };

  if (pendingQuestions) {
    const withRecommendation = pendingQuestions.filter((q) => q.recommended !== undefined);
    const n = pendingQuestions.length;
    return (
      <Modal title="Unanswered questions" onClose={() => setPendingQuestions(null)}>
        <p class="zen-muted">{n === 1 ? "1 question has" : `${n} questions have`} no answer:</p>
        <ul class="zen-question-list">
          {pendingQuestions.map((q) => (
            <li key={q.id}>
              {q.title}
              {q.recommended !== undefined && (
                <span class="zen-muted"> · recommended: {q.recommended}</span>
              )}
            </li>
          ))}
        </ul>
        {error && <p class="zen-error">{error}</p>}
        <div class="zen-modal-actions">
          <button type="button" class="zen-btn" onClick={() => setPendingQuestions(null)}>
            Back
          </button>
          <button type="button" class="zen-btn" disabled={busy} onClick={() => void send()}>
            Leave unanswered
          </button>
          <button
            type="button"
            class="zen-btn zen-btn-primary"
            disabled={busy || withRecommendation.length === 0}
            onClick={() => {
              actions.acceptRecommended(withRecommendation.map((q) => q.id));
              void send();
            }}
          >
            Accept recommended for {withRecommendation.length}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Submit review" onClose={close} onSubmit={onSubmit}>
      <div class="zen-verdicts" role="radiogroup" aria-label="Verdict">
        {VERDICTS.map((v) => (
          <label key={v.value} class={`zen-verdict zen-verdict-${v.value}`}>
            <input
              type="radio"
              name="verdict"
              value={v.value}
              checked={verdict === v.value}
              onChange={() => {
                setVerdict(v.value);
                remember(v.value, summary);
              }}
            />
            <span>
              <strong>{v.label}</strong>
              <small>{v.hint}</small>
            </span>
          </label>
        ))}
      </div>
      <label class="zen-label">
        Summary
        <textarea
          class="zen-textarea"
          rows={3}
          value={summary}
          placeholder="Overall feedback (optional)"
          onInput={(e) => setSummary((e.currentTarget as HTMLTextAreaElement).value)}
          onBlur={() => remember(verdict, summary)}
        />
      </label>
      <p class="zen-muted zen-submit-counts">
        {counts.items} new {counts.items === 1 ? "item" : "items"} · {counts.reopen} reopened ·{" "}
        {counts.replies} {counts.replies === 1 ? "reply" : "replies"} · {counts.resolve} resolved ·
        against revision {store.latest.value?.n ?? "—"}
      </p>
      {error && <p class="zen-error">{error}</p>}
      <div class="zen-modal-actions">
        <button type="button" class="zen-btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" class={`zen-btn zen-btn-primary zen-btn-${verdict}`} disabled={busy}>
          {busy ? "Submitting…" : "Submit review"}
        </button>
      </div>
    </Modal>
  );
}

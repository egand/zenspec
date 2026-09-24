/** Revision timeline (§9): pick two revisions to diff them in the document view. */
import { useState } from "preact/hooks";
import { useApp } from "../app/actions.js";

export function RevisionsTab() {
  const { store, ui } = useApp();
  const revisions = store.revisions.value;
  const reviews = store.state.value.reviews;
  const latestN = store.latest.value?.n ?? 0;
  const compare = ui.compare.value;
  const [picked, setPicked] = useState<number[]>(compare ? [compare.from, compare.to] : []);
  const lastReviewed = store.lastReview.value?.revision;

  const toggle = (n: number) =>
    setPicked((list) => (list.includes(n) ? list.filter((x) => x !== n) : [...list, n].slice(-2)));
  const show = (from: number, to: number) => {
    ui.compare.value = { from: Math.min(from, to), to: Math.max(from, to) };
    setPicked([from, to]);
  };

  return (
    <div class="zen-tab-pane">
      <div class="zen-revision-actions">
        <button
          type="button"
          class="zen-btn"
          disabled={picked.length !== 2}
          onClick={() => show(picked[0]!, picked[1]!)}
        >
          Compare selected
        </button>
        <button
          type="button"
          class="zen-btn"
          disabled={!lastReviewed || lastReviewed >= latestN}
          title="Diff from the revision you last reviewed to the latest"
          onClick={() => lastReviewed && show(lastReviewed, latestN)}
        >
          Changes since my last review
        </button>
        {compare && (
          <button type="button" class="zen-btn-sm" onClick={() => (ui.compare.value = null)}>
            Back to live
          </button>
        )}
      </div>
      {compare && (
        <p class="zen-compare-note">
          Showing r{compare.to} with changes since r{compare.from}.
        </p>
      )}
      <div class="zen-scroll">
        {!revisions.length && <p class="zen-empty">No revision published yet.</p>}
        <ol class="zen-timeline">
          {[...revisions].reverse().map((r) => {
            const reviewed = reviews.filter((rv) => rv.revision === r.n);
            return (
              <li key={r.n} class={picked.includes(r.n) ? "picked" : ""}>
                <label class="zen-timeline-row">
                  <input
                    type="checkbox"
                    checked={picked.includes(r.n)}
                    onChange={() => toggle(r.n)}
                  />
                  <span class="zen-rev">r{r.n}</span>
                  <span class="zen-timeline-summary">{r.summary || <em>no summary</em>}</span>
                </label>
                <div class="zen-muted zen-small">
                  {r.author} · {new Date(r.ts).toLocaleString()}
                  {reviewed.map((rv) => (
                    <span key={rv.n} class={`zen-verdict-chip zen-verdict-${rv.verdict}`}>
                      review {rv.n}: {rv.verdict.replace("_", " ")}
                    </span>
                  ))}
                </div>
                {r.n > 1 && (
                  <button type="button" class="zen-btn-sm" onClick={() => show(r.n - 1, r.n)}>
                    Diff with r{r.n - 1}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

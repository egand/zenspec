/** Living plans (§10): step progress and the drift banner. */
import { useState } from "preact/hooks";
import { diffHunks } from "../../core/diff.js";
import { useApp } from "./actions.js";

export function progressOf(steps: readonly { checked: boolean }[]) {
  const done = steps.filter((s) => s.checked).length;
  return {
    done,
    total: steps.length,
    pct: steps.length ? Math.round((done / steps.length) * 100) : 0,
  };
}

export function StepProgress() {
  const { store } = useApp();
  const phase = store.phase.value;
  const steps = store.parsed.value?.steps ?? [];
  if (!steps.length || phase === "drafting" || phase === "in_review") return null;
  const { done, total, pct } = progressOf(steps);
  const current = steps.find((s) => !s.checked);
  return (
    <div class="zen-progress" aria-label="Implementation progress">
      <div class="zen-progress-track">
        <div class="zen-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span class="zen-progress-label">
        {done}/{total} steps{current ? ` · next: ${current.text}` : " · all done"}
      </span>
    </div>
  );
}

export function DriftBanner() {
  const { store, actions } = useApp();
  const [open, setOpen] = useState(false);
  const drift = store.drift.value;
  if (!drift.length) return null;
  const last = drift.at(-1)!;
  const before = store.latestText.value;
  const hunks = before !== undefined && open ? diffHunks(before, store.content.value) : [];

  const decide = (verdict: "comment" | "changes_requested", summary: string) => {
    actions.setVerdict(verdict, summary);
    actions.openSubmit(verdict);
  };

  return (
    <div class="zen-banner zen-banner-warn" role="status">
      <div class="zen-banner-row">
        <strong>The plan changed after approval</strong>
        <span class="zen-muted">{last.diffSummary}</span>
        <span class="zen-spacer" />
        <button type="button" class="zen-btn-sm" onClick={() => setOpen(!open)}>
          {open ? "Hide diff" : "Show diff"}
        </button>
        <button
          type="button"
          class="zen-btn-sm"
          onClick={() => decide("comment", "Accepted the plan changes.")}
        >
          Accept
        </button>
        <button
          type="button"
          class="zen-btn-sm zen-btn-danger"
          onClick={() => decide("changes_requested", "Please revisit the plan changes.")}
        >
          Request changes
        </button>
      </div>
      {open && (
        <pre class="zen-diff">
          {hunks.flatMap((h) =>
            h.lines.map((l, i) => (
              <div key={`${h.newStart}-${i}`} class={`zen-diff-${l.op}`}>
                {l.op === "insert" ? "+ " : l.op === "delete" ? "- " : "  "}
                {l.text}
              </div>
            )),
          )}
        </pre>
      )}
    </div>
  );
}

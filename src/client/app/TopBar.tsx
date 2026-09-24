/** Document name, phase, connection and unpublished-changes state, main actions. */
import type { ComponentChildren } from "preact";
import { PAGES } from "../../core/api.js";
import type { Phase } from "../../core/types.js";
import { useApp } from "./actions.js";

const PHASE_LABEL: Record<Phase, string> = {
  drafting: "drafting",
  in_review: "in review",
  approved: "approved",
  implementing: "implementing",
  done: "done",
};

export function PhaseBadge({ phase }: { phase: Phase }) {
  return <span class={`zen-phase zen-phase-${phase}`}>{PHASE_LABEL[phase]}</span>;
}

export function Brand() {
  return (
    <a class="zen-brand" href={PAGES.inbox} title="Inbox">
      <span class="zen-logo" aria-hidden="true">
        ◐
      </span>
      <span class="zen-brand-name">ZenSpec</span>
    </a>
  );
}

export function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const light = root.dataset.theme !== "light";
    if (light) root.dataset.theme = "light";
    else delete root.dataset.theme;
    try {
      localStorage.setItem("zen-theme", light ? "light" : "dark");
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  };
  return (
    <button type="button" class="zen-icon-btn" title="Toggle light/dark" onClick={toggle}>
      ☾
    </button>
  );
}

export function Bar({ children }: { children: ComponentChildren }) {
  return <header class="zen-topbar">{children}</header>;
}

export function TopBar() {
  const { store, actions } = useApp();
  const ref = store.ref.value;
  const name = ref?.relPath.split("/").pop() ?? "…";
  const closed = store.state.value.closed;
  const connection = store.connection.value;

  return (
    <Bar>
      <Brand />
      <div class="zen-doc-title" title={ref ? `${ref.repoRoot}/${ref.relPath}` : undefined}>
        <span class="zen-doc-name">{name}</span>
        {ref && <span class="zen-doc-path">{ref.relPath}</span>}
      </div>
      <PhaseBadge phase={store.phase.value} />
      {store.latest.value && <span class="zen-chip">r{store.latest.value.n}</span>}
      {store.unpublished.value && (
        <span
          class="zen-chip zen-chip-warn"
          title="The file changed since the last published revision"
        >
          unpublished changes
        </span>
      )}
      {closed && <span class="zen-chip">closed by {closed.by}</span>}
      {connection !== "open" && store.loaded.value && (
        <span class="zen-chip zen-chip-muted">reconnecting…</span>
      )}
      <span class="zen-spacer" />
      <ThemeToggle />
      <button
        type="button"
        class="zen-btn zen-btn-primary"
        disabled={!store.latest.value}
        title="Submit review (a: approve)"
        onClick={() => actions.openSubmit()}
      >
        Submit review
      </button>
    </Bar>
  );
}

/** Right sidebar: Draft, Threads, Revisions. Each tab owns its scroll area (§9.1). */
import { useApp } from "../app/actions.js";
import type { PanelTab } from "../app/ui.js";
import { DraftTab } from "./DraftTab.js";
import { RevisionsTab } from "./RevisionsTab.js";
import { ThreadsTab } from "./ThreadsTab.js";

export function ReviewPanel() {
  const { store, ui } = useApp();
  const draft = store.draft.value;
  const draftCount =
    (draft?.threads.length ?? 0) + (draft?.reopen.length ?? 0) + (draft?.resolve.length ?? 0);
  const openCount = store.threads.value.filter((t) => t.status === "open").length;
  const tabs: { id: PanelTab; label: string; count?: number }[] = [
    { id: "draft", label: "Draft", count: draftCount },
    { id: "threads", label: "Threads", count: openCount },
    { id: "revisions", label: "Revisions", count: store.revisions.value.length },
  ];

  return (
    <aside class="zen-panel" aria-label="Review">
      <nav class="zen-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={ui.tab.value === t.id}
            class={`zen-tab${ui.tab.value === t.id ? " active" : ""}`}
            onClick={() => (ui.tab.value = t.id)}
          >
            {t.label}
            {!!t.count && <span class="zen-count">{t.count}</span>}
          </button>
        ))}
      </nav>
      <div class="zen-tab-body">
        {ui.tab.value === "draft" && <DraftTab />}
        {ui.tab.value === "threads" && <ThreadsTab />}
        {ui.tab.value === "revisions" && <RevisionsTab />}
      </div>
    </aside>
  );
}

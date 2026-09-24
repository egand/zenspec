/** The review page of one document: top bar, document view, review panel, dialogs. */
import { useEffect, useMemo } from "preact/hooks";
import { DocumentView } from "../doc/index.js";
import { Lightbox } from "../review/Attachments.js";
import { Composer } from "../review/Composer.js";
import { ReviewPanel } from "../review/ReviewPanel.js";
import { SubmitDialog } from "../review/SubmitDialog.js";
import { createApi, type DocAddress } from "../store/api.js";
import { createDocStore } from "../store/doc-store.js";
import { answersFor, changedLines, highlightsFor, kbTermsFor } from "../store/view.js";
import { AppContext, createActions, useApp, type AppContextValue } from "./actions.js";
import { DriftBanner, StepProgress } from "./LivingPlan.js";
import { useShortcuts } from "./shortcuts.js";
import { TopBar } from "./TopBar.js";
import { createUi } from "./ui.js";

export function createApp(address: DocAddress): AppContextValue {
  const store = createDocStore({ api: createApi(address) });
  const ui = createUi();
  return { store, ui, actions: createActions(store, ui) };
}

export function DocPage({ address }: { address: DocAddress }) {
  const app = useMemo(() => createApp(address), [address.repoId, address.docId]);
  useEffect(() => {
    void app.store.start();
    const flush = () => void app.store.flushDraft();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      app.store.stop();
    };
  }, [app]);
  useShortcuts(app);

  return (
    <AppContext.Provider value={app}>
      <Shell />
    </AppContext.Provider>
  );
}

function Shell() {
  const { store } = useApp();
  const title = store.ref.value?.relPath.split("/").pop();
  useEffect(() => {
    if (title) document.title = `${title} · ZenSpec`;
  }, [title]);

  return (
    <div class="zen-app">
      <TopBar />
      <DriftBanner />
      <StepProgress />
      <div class="zen-main">
        <main class="zen-doc-pane">
          {store.loadError.value && !store.loaded.value ? (
            <p class="zen-error zen-pad">Could not load the document: {store.loadError.value}</p>
          ) : store.loaded.value ? (
            <DocumentPane />
          ) : (
            <p class="zen-muted zen-pad">Loading…</p>
          )}
        </main>
        <ReviewPanel />
      </div>
      <Composer />
      <SubmitDialog />
      <Lightbox />
    </div>
  );
}

function DocumentPane() {
  const { store, ui, actions } = useApp();
  const compare = ui.compare.value;
  const texts = store.revisionTexts.value;

  useEffect(() => {
    if (!compare) return;
    store.loadRevision(compare.from).catch(() => {});
    store.loadRevision(compare.to).catch(() => {});
  }, [compare?.from, compare?.to]);

  let source = store.source.value;
  let diff: { added: number[]; modified: number[] } | undefined;
  if (compare) {
    const from = texts[compare.from];
    source = texts[compare.to] ?? "";
    diff =
      from !== undefined && texts[compare.to] !== undefined
        ? changedLines(from, source)
        : undefined;
  } else if (store.unpublished.value && store.latestText.value !== undefined) {
    diff = changedLines(store.latestText.value, source);
  }

  const threads = store.threads.value;
  const draft = store.draft.value;
  const steps = Object.fromEntries(
    Object.entries(store.steps.value).map(([id, s]) => [
      id,
      { checked: s.checked, checkedAt: s.ts },
    ]),
  );

  return (
    <DocumentView
      kind={store.ref.value?.kind ?? "markdown"}
      source={source}
      highlights={highlightsFor(threads, draft, ui.active.value ?? undefined)}
      diffLines={diff}
      answers={answersFor(threads, draft, store.questions.value)}
      steps={steps}
      kbTerms={kbTermsFor(store.kbNotes.value)}
      focus={ui.focus.value}
      onSelect={actions.select}
      onAnswer={actions.answer}
      onHighlightClick={actions.highlightClicked}
    />
  );
}

/**
 * The document store (plan §5, §15): the daemon's event log reduced with the same core `reduce`,
 * the live file content, and the reviewer's draft, all as signals.
 *
 * - Load: subscribe to the document's SSE stream; every (re)connect resyncs from `GET doc`.
 * - Events arriving during a resync are buffered and applied after it, deduplicated. Resyncs
 *   never overlap: a resync requested during one runs once after it.
 * - Draft edits are applied locally at once and saved to the daemon, debounced. While local
 *   edits are unsaved, draft pushes from the daemon are ignored so they can't clobber them.
 */
import { batch, computed, signal } from "@preact/signals";
import type { KbNote, Presence, SseMessage } from "../../core/api.js";
import { SSE_EVENTS } from "../../core/api.js";
import { reanchorDraft } from "../../core/anchor.js";
import type { ZenEvent } from "../../core/events.js";
import { parseDocument } from "../../core/parse.js";
import {
  initialState,
  latestReview,
  latestRevision,
  pendingDrift,
  reduce,
  replay,
  threadList,
} from "../../core/reducer.js";
import type { DocState, DocumentRef, Draft, Verdict } from "../../core/types.js";
import type { Api } from "./api.js";
import { emptyDraft, toSubmitRequest } from "./draft.js";
import { subscribe, type ConnectionStatus, type SseOptions } from "./sse.js";

export interface DocStoreOptions {
  api: Api;
  sse?: SseOptions;
  /** Debounce for draft saves. */
  saveDelayMs?: number;
}

export type SaveStatus = "saved" | "pending" | "saving" | "error";

const eventKey = (e: ZenEvent) => JSON.stringify(e);

export function createDocStore({ api, sse, saveDelayMs = 400 }: DocStoreOptions) {
  // -------------------------------------------------------------------------
  // Raw state
  // -------------------------------------------------------------------------
  const ref = signal<DocumentRef | null>(null);
  const state = signal<DocState>(initialState());
  const content = signal("");
  const contentHash = signal("");
  const draft = signal<Draft | null>(null);
  const revisionTexts = signal<Record<number, string>>({});
  const kbNotes = signal<KbNote[]>([]);
  const loaded = signal(false);
  const loadError = signal<string | null>(null);
  const connection = signal<ConnectionStatus>("connecting");
  const saveStatus = signal<SaveStatus>("saved");
  const presence = signal<Presence>({ waiting: 0 });

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------
  const threads = computed(() => threadList(state.value));
  const revisions = computed(() => state.value.revisions);
  const latest = computed(() => latestRevision(state.value));
  const lastReview = computed(() => latestReview(state.value));
  const phase = computed(() => state.value.phase);
  const steps = computed(() => state.value.steps);
  /** Drift neither accepted nor followed by a review: what the banner shows (§10). */
  const drift = computed(() => pendingDrift(state.value));
  const latestText = computed(() => {
    const n = latest.value?.n;
    return n === undefined ? undefined : revisionTexts.value[n];
  });
  /** What the reviewer sees: the file on disk, ahead of the last revision when unpublished. */
  const source = computed(() => content.value || latestText.value || "");
  const unpublished = computed(
    () => !!latest.value && !!contentHash.value && contentHash.value !== latest.value.contentHash,
  );
  const parsed = computed(() =>
    ref.value?.kind === "markdown" ? parseDocument(source.value) : null,
  );
  const questions = computed(() => parsed.value?.questions ?? []);

  // -------------------------------------------------------------------------
  // Events and resync
  // -------------------------------------------------------------------------
  let seen = new Set<string>();
  let buffer: ZenEvent[] | null = null;

  function applyEvent(event: ZenEvent): void {
    if (buffer) {
      buffer.push(event);
      return;
    }
    const key = eventKey(event);
    if (seen.has(key)) return;
    seen.add(key);
    state.value = reduce(state.value, event);
    if (event.type === "revision_published") void onRevision(event.n);
  }

  let resyncing: Promise<void> | null = null;
  let queuedResync: Promise<void> | null = null;

  /**
   * Single-flight: `start()` and the SSE `onOpen` both resync, and they share the event buffer.
   * A call during a resync coalesces into one more resync after it, so events published after
   * the in-flight snapshot was taken are still picked up.
   */
  function resync(): Promise<void> {
    if (!resyncing) {
      resyncing = fetchAndReplay().finally(() => (resyncing = null));
      return resyncing;
    }
    queuedResync ??= resyncing.then(() => {
      queuedResync = null;
      return resync();
    });
    return queuedResync;
  }

  async function fetchAndReplay(): Promise<void> {
    buffer = [];
    try {
      const snap = await api.docState();
      const pending = buffer;
      buffer = null;
      seen = new Set(snap.events.map(eventKey));
      batch(() => {
        ref.value = snap.doc;
        state.value = replay(snap.events);
        setContent(snap.content, snap.contentHash);
        presence.value = snap.presence;
        if (!hasLocalEdits()) draft.value = snap.draft;
        loaded.value = true;
        loadError.value = null;
        for (const e of pending) applyEvent(e);
      });
      const n = latest.value?.n;
      if (n !== undefined) void loadRevision(n);
    } catch (err) {
      buffer = null;
      loadError.value = (err as Error).message;
    }
  }

  function setContent(text: string, hash: string): void {
    content.value = text;
    contentHash.value = hash;
    const last = latest.value;
    if (last && last.contentHash === hash) cacheRevision(last.n, text);
  }

  function onMessage(message: SseMessage): void {
    switch (message.event) {
      case SSE_EVENTS.event:
        return applyEvent(message.data);
      case SSE_EVENTS.content:
        return setContent(message.data.content, message.data.contentHash);
      case SSE_EVENTS.presence:
        presence.value = message.data;
        return;
      case SSE_EVENTS.draft:
        if (!hasLocalEdits()) draft.value = message.data.draft;
    }
  }

  // -------------------------------------------------------------------------
  // Revisions
  // -------------------------------------------------------------------------
  const inflightRevisions = new Map<number, Promise<string>>();

  function cacheRevision(n: number, text: string): void {
    if (revisionTexts.value[n] !== text)
      revisionTexts.value = { ...revisionTexts.value, [n]: text };
  }

  function loadRevision(n: number): Promise<string> {
    const cached = revisionTexts.value[n];
    if (cached !== undefined) return Promise.resolve(cached);
    let pending = inflightRevisions.get(n);
    if (!pending) {
      pending = api.revisionText(n).then((text) => {
        cacheRevision(n, text);
        return text;
      });
      pending.finally(() => inflightRevisions.delete(n)).catch(() => {});
      inflightRevisions.set(n, pending);
    }
    return pending;
  }

  /**
   * The daemon re-anchors the saved draft on publish and pushes it. Unsaved local edits would
   * overwrite that, so they are re-anchored here with the same core function (§9.1).
   */
  async function onRevision(n: number): Promise<void> {
    const text = await loadRevision(n).catch(() => null);
    const current = draft.value;
    if (!current || current.revision >= n || !hasLocalEdits()) return;
    const kind = ref.value?.kind;
    updateDraft((d) => {
      if (kind !== "markdown" || text === null) return { ...d, revision: n };
      const blocks = parseDocument(text).blocks;
      const snap = { kind: "markdown" as const, revision: n, text, blocks };
      return { ...d, revision: n, threads: reanchorDraft(d.threads, snap) };
    });
  }

  // -------------------------------------------------------------------------
  // Draft persistence
  // -------------------------------------------------------------------------
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let saving: Promise<void> | null = null;

  function hasLocalEdits(): boolean {
    return dirty || saving !== null;
  }

  function updateDraft(change: (d: Draft) => Draft): void {
    const base = draft.value ?? emptyDraft(latest.value?.n ?? 0);
    draft.value = change(base);
    dirty = true;
    saveStatus.value = "pending";
    clearTimeout(timer);
    timer = setTimeout(() => void flushDraft(), saveDelayMs);
  }

  async function flushDraft(): Promise<void> {
    clearTimeout(timer);
    if (saving) await saving;
    const value = draft.value;
    if (!dirty || !value) return;
    dirty = false;
    saveStatus.value = "saving";
    saving = api
      .saveDraft(value)
      .then(() => {
        if (!dirty) saveStatus.value = "saved";
      })
      .catch(() => {
        dirty = true;
        saveStatus.value = "error";
      })
      .finally(() => {
        saving = null;
      });
    await saving;
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------
  async function submit(verdict: Verdict, summary: string) {
    const revision = latest.value?.n;
    if (revision === undefined) throw new Error("Nothing has been published yet");
    // A save landing after the submit would resurrect the draft the daemon just cleared.
    clearTimeout(timer);
    const wasDirty = dirty;
    dirty = false;
    if (saving) await saving;
    const request = toSubmitRequest(draft.value, revision, verdict, summary);
    try {
      const res = await api.submitReview(request);
      draft.value = null;
      saveStatus.value = "saved";
      return res.review;
    } catch (err) {
      if (wasDirty) updateDraft((d) => d);
      throw err;
    }
  }

  /** §10: the `drift_accepted` event arrives over SSE and clears the banner. */
  async function acceptDrift(): Promise<void> {
    await api.acceptDrift();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  let unsubscribe: (() => void) | null = null;

  function start(): Promise<void> {
    api
      .kbTerms()
      .then((r) => (kbNotes.value = r.notes))
      .catch(() => {});
    unsubscribe = subscribe(
      api.eventsUrl(),
      {
        onMessage,
        onOpen: () => void resync(),
        onStatus: (s) => (connection.value = s),
      },
      sse,
    );
    return resync();
  }

  function stop(): void {
    unsubscribe?.();
    unsubscribe = null;
    void flushDraft();
  }

  return {
    api,
    // raw
    ref,
    state,
    content,
    contentHash,
    draft,
    revisionTexts,
    kbNotes,
    loaded,
    loadError,
    connection,
    saveStatus,
    presence,
    // derived
    threads,
    revisions,
    latest,
    lastReview,
    phase,
    steps,
    drift,
    latestText,
    source,
    unpublished,
    parsed,
    questions,
    // actions
    start,
    stop,
    resync,
    applyEvent,
    onMessage,
    loadRevision,
    updateDraft,
    flushDraft,
    submit,
    acceptDrift,
  };
}

export type DocStore = ReturnType<typeof createDocStore>;

import { describe, expect, it } from "vitest";
import { SSE_EVENTS } from "../../../src/core/api.js";
import { replay } from "../../../src/core/reducer.js";
import type { Draft, MarkdownAnchor } from "../../../src/core/types.js";
import { addThread, emptyDraft } from "../../../src/client/store/draft.js";
import {
  DOC_TEXT,
  FakeEventSource,
  fakeApi,
  flush,
  makeStore,
  revisionEvent,
  reviewEvent,
  wait,
} from "./fakes.js";

const anchor = (quote: string, block = "plan/p1"): MarkdownAnchor => ({
  type: "markdown",
  rev: 1,
  block,
  quote,
  prefix: "",
  suffix: "",
  lines: [3, 3],
});

describe("doc store: events", () => {
  it("applies SSE events with the core reducer, ignoring duplicates", async () => {
    const { store, api } = makeStore();
    await store.start();
    const review = reviewEvent(1, 1, [
      { id: "t1", kind: "comment", anchor: anchor("Redis"), body: "why?", attachments: [] },
    ]);

    FakeEventSource.last.emit(SSE_EVENTS.event, review);
    FakeEventSource.last.emit(SSE_EVENTS.event, review);

    expect(store.state.value).toEqual(replay([...api.state.events, review]));
    expect(store.threads.value.map((t) => t.id)).toEqual(["t1"]);
    expect(store.phase.value).toBe("in_review");
    expect(store.lastReview.value?.n).toBe(1);
  });

  it("tracks unpublished content and the live source", async () => {
    const { store } = makeStore();
    await store.start();
    expect(store.unpublished.value).toBe(false);

    FakeEventSource.last.emit(SSE_EVENTS.content, { content: "# Changed\n", contentHash: "h2" });
    expect(store.source.value).toBe("# Changed\n");
    expect(store.unpublished.value).toBe(true);
  });

  it("resyncs from the daemon after a reconnect", async () => {
    const { store, api } = makeStore();
    await store.start();
    FakeEventSource.last.open();
    await flush();
    const calls = api.docState.mock.calls.length;

    // Missed while disconnected.
    api.state.events.push(revisionEvent(2, "hash-2"));
    FakeEventSource.last.fail();
    expect(store.connection.value).toBe("reconnecting");
    await wait(5);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.last.open();
    await flush();

    expect(api.docState.mock.calls.length).toBe(calls + 1);
    expect(store.latest.value?.n).toBe(2);
    expect(store.connection.value).toBe("open");
  });
});

describe("doc store: draft", () => {
  it("saves reviewer actions to the daemon, debounced", async () => {
    const { store, api } = makeStore();
    await store.start();

    store.updateDraft((d) => addThread(d, { kind: "general" }, "first"));
    store.updateDraft((d) => addThread(d, { kind: "general" }, "second"));
    expect(api.saveDraft).not.toHaveBeenCalled();
    await wait(30);

    expect(api.saveDraft).toHaveBeenCalledTimes(1);
    expect(api.saveDraft.mock.calls[0]![0].threads.map((t) => t.body)).toEqual(["first", "second"]);
    expect(store.saveStatus.value).toBe("saved");
  });

  it("restores the saved draft on load", async () => {
    const saved: Draft = addThread(emptyDraft(1), { kind: "general" }, "kept across reloads");
    const { store } = makeStore(fakeApi({ draft: saved }));
    await store.start();
    expect(store.draft.value?.threads[0]?.body).toBe("kept across reloads");
  });

  it("does not let a daemon draft push clobber unsaved local edits", async () => {
    const { store } = makeStore();
    await store.start();
    store.updateDraft((d) => addThread(d, { kind: "general" }, "local"));

    FakeEventSource.last.emit(SSE_EVENTS.draft, { draft: null });
    expect(store.draft.value?.threads).toHaveLength(1);

    await wait(30);
    FakeEventSource.last.emit(SSE_EVENTS.draft, { draft: null });
    expect(store.draft.value).toBeNull();
  });

  it("re-anchors unsaved draft items when a revision is published", async () => {
    const { store, api } = makeStore();
    await store.start();
    store.updateDraft((d) => addThread(d, { kind: "comment", anchor: anchor("Redis") }, "keep"));
    store.updateDraft((d) =>
      addThread(d, { kind: "comment", anchor: anchor("memcached", "removed-section/p1") }, "gone"),
    );
    const next = DOC_TEXT.replace("We cache", "Today we cache");
    api.revisionText.mockResolvedValue(next);

    FakeEventSource.last.emit(SSE_EVENTS.event, revisionEvent(2));
    await wait(30);

    const draft = store.draft.value!;
    expect(draft.revision).toBe(2);
    expect(draft.threads.map((t) => !!t.orphaned)).toEqual([false, true]);
    expect(draft.threads[1]!.kind !== "general" && draft.threads[1]!.anchor).toMatchObject({
      quote: "memcached",
    });
    expect(api.saveDraft.mock.calls.at(-1)![0].revision).toBe(2);
  });

  it("submits the draft and clears it without a late save resurrecting it", async () => {
    const { store, api } = makeStore();
    await store.start();
    store.updateDraft((d) => addThread(d, { kind: "general" }, "note"));

    await store.submit("comment", "ok");
    await wait(30);

    expect(api.submitReview).toHaveBeenCalledTimes(1);
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(store.draft.value).toBeNull();
  });
});

// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { EVENT_SCHEMA_VERSION, type AgentResponded } from "../../../src/core/events.js";
import { Composer } from "../../../src/client/review/Composer.js";
import { ThreadsTab } from "../../../src/client/review/ThreadsTab.js";
import { fakeApi, revisionEvent, reviewEvent } from "../store/fakes.js";
import { button, click, mount, type } from "./harness.js";

const responded: AgentResponded = {
  schemaVersion: EVENT_SCHEMA_VERSION,
  ts: "2026-09-24T01:00:00.000Z",
  author: "agent",
  type: "agent_responded",
  revision: 1,
  responses: [{ thread: "t1", action: "edited", note: "Switched to write-through" }],
};

function apiWithThreads() {
  return fakeApi({
    events: [
      revisionEvent(1, "hash-1"),
      reviewEvent(1, 1, [
        { id: "t1", kind: "general", body: "Add a caching section", attachments: [] },
        { id: "t2", kind: "general", body: "Still open", attachments: [] },
      ]),
      responded,
    ],
  });
}

describe("threads panel", () => {
  it("shows the agent's reply inside its thread", async () => {
    const { root } = await mount(<ThreadsTab />, apiWithThreads());
    const card = root.querySelector('[data-id="t1"]')!;
    expect(card.textContent).toContain("Add a caching section");
    expect(card.textContent).toContain("agent edited the document");
    expect(card.textContent).toContain("Switched to write-through");
  });

  it("stages Resolve in the draft and can undo it", async () => {
    const { app, root } = await mount(<ThreadsTab />, apiWithThreads());
    const card = () => root.querySelector<HTMLElement>('[data-id="t1"]')!;

    await click(button(card(), "Resolve"));
    expect(app.store.draft.value?.resolve).toEqual(["t1"]);
    expect(card().textContent).toContain("Resolve staged");

    await click(button(card(), "Undo"));
    expect(app.store.draft.value?.resolve).toEqual([]);
  });

  it("stages a reply as a reopen with its message", async () => {
    const { app, root } = await mount(
      <>
        <ThreadsTab />
        <Composer />
      </>,
      apiWithThreads(),
    );
    const card = root.querySelector<HTMLElement>('[data-id="t1"]')!;
    await click(button(card, "Reply"));
    expect(app.ui.composer.value).toEqual({ mode: "reply", threadId: "t1" });

    await type(root.querySelector(".zen-modal textarea")!, "Also cover eviction");
    await click(button(root, "Stage reply"));
    expect(app.store.draft.value?.reopen).toEqual([
      { thread: "t1", body: "Also cover eviction", attachments: [] },
    ]);
    expect(app.ui.composer.value).toBeNull();
  });

  it("offers only Resolve on an open thread", async () => {
    const { root } = await mount(<ThreadsTab />, apiWithThreads());
    const card = root.querySelector<HTMLElement>('[data-id="t2"]')!;
    expect(button(card, "Resolve")).toBeTruthy();
    expect(() => button(card, "Reply")).toThrow();
  });
});

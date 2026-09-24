// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { SSE_EVENTS } from "../../../src/core/api.js";
import { EVENT_SCHEMA_VERSION, type ZenEvent } from "../../../src/core/events.js";
import { useApp } from "../../../src/client/app/actions.js";
import { DriftBanner } from "../../../src/client/app/LivingPlan.js";
import { AGENT_WORKING_MS, AgentPresence, agentStatus } from "../../../src/client/app/TopBar.js";
import { FakeEventSource, fakeApi, revisionEvent, reviewEvent } from "../store/fakes.js";
import { button, click, mount, settle } from "./harness.js";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("agent presence", () => {
  it("is waiting while a review call blocks, working when recently active, else nothing", () => {
    expect(agentStatus({ waiting: 2, agentSeenAt: ago(60 * 60_000) }, NOW)).toBe("waiting");
    expect(agentStatus({ waiting: 0, agentSeenAt: ago(60_000) }, NOW)).toBe("working");
    expect(agentStatus({ waiting: 0, agentSeenAt: ago(AGENT_WORKING_MS + 1) }, NOW)).toBeNull();
    expect(agentStatus({ waiting: 0 }, NOW)).toBeNull();
  });

  it("follows presence pushed over SSE", async () => {
    const Chip = () => {
      const { store } = useApp();
      return <AgentPresence presence={store.presence.value} />;
    };
    const { root } = await mount(<Chip />);
    expect(root.textContent).toBe("");
    await settle(() =>
      FakeEventSource.last.emit(SSE_EVENTS.presence, {
        waiting: 1,
        agentSeenAt: new Date().toISOString(),
      }),
    );
    expect(root.querySelector(".zen-presence-waiting")?.textContent).toBe("agent waiting");
    await settle(() =>
      FakeEventSource.last.emit(SSE_EVENTS.presence, {
        waiting: 0,
        agentSeenAt: new Date().toISOString(),
      }),
    );
    expect(root.textContent).toBe("agent working");
  });
});

describe("drift banner", () => {
  const drifted: ZenEvent = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    ts: "2026-09-24T02:00:00.000Z",
    author: "agent",
    type: "plan_drifted",
    revision: 1,
    diffSummary: "+1 -0 lines at L7",
  };
  const approved = { ...reviewEvent(1, 1, [], "approved"), ts: "2026-09-24T01:00:00.000Z" };

  it("accepts drift with the typed endpoint, not a review, and hides once accepted", async () => {
    const api = fakeApi({ events: [revisionEvent(1, "hash-1"), approved, drifted] });
    const { app, root } = await mount(<DriftBanner />, api);
    expect(root.textContent).toContain("+1 -0 lines at L7");

    await click(button(root, "Accept"));
    expect(api.acceptDrift).toHaveBeenCalledTimes(1);
    expect(api.submitReview).not.toHaveBeenCalled();
    expect(app.ui.submit.value).toBeNull();

    await settle(() =>
      FakeEventSource.last.emit(SSE_EVENTS.event, {
        schemaVersion: EVENT_SCHEMA_VERSION,
        ts: "2026-09-24T03:00:00.000Z",
        author: "reviewer",
        type: "drift_accepted",
      }),
    );
    expect(root.textContent).toBe("");
    expect(app.store.phase.value).toBe("approved");
  });
});

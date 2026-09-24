import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { GateResponse, InboxPendingResponse, InboxResponse } from "../../src/core/api.js";
import { ROUTES } from "../../src/core/api.js";
import type { ZenEvent } from "../../src/core/events.js";
import { pendingDrift, replay } from "../../src/core/reducer.js";
import type { DaemonOptions } from "../../src/daemon/index.js";
import { startTestDaemon, tempRepo, type Doc } from "./helpers.js";

const PLAN = ["# Plan", "", "## Steps", "", "- [ ] Build event log", "- [ ] Write daemon", ""].join(
  "\n",
);

async function approvedPlan(options: DaemonOptions = {}) {
  const root = tempRepo({ "docs/plans/plan.md": PLAN, "src/app.ts": "" });
  const t = await startTestDaemon(options);
  const doc = await t.open(`${root}/docs/plans/plan.md`);
  await doc.publish();
  await doc.submit({ revision: 1, verdict: "approved" });
  return { ...t, root, doc };
}

async function eventsOfType(doc: Doc, type: ZenEvent["type"]): Promise<ZenEvent[]> {
  return (await doc.state()).events.filter((e) => e.type === type);
}

function loggedTypes(home: string, doc: Doc): string[] {
  const log = path.join(home, "repos", doc.repoId, "docs", doc.docId, "events.jsonl");
  return fs
    .readFileSync(log, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => (JSON.parse(line) as ZenEvent).type);
}

describe("living plans", () => {
  it("records checkbox edits as steps and other edits as drift", async () => {
    const { doc } = await approvedPlan();

    doc.write(PLAN.replace("- [ ] Build", "- [x] Build"));
    await vi.waitFor(async () => expect(await eventsOfType(doc, "step_checked")).toHaveLength(1));
    const [checked] = await eventsOfType(doc, "step_checked");
    expect(checked).toMatchObject({ step: "steps/build-event-log", checked: true });
    expect((await doc.state()).events.some((e) => e.type === "plan_drifted")).toBe(false);

    doc.write(PLAN.replace("- [ ] Build", "- [x] Build") + "- [ ] Ship it\n");
    await vi.waitFor(async () => expect(await eventsOfType(doc, "plan_drifted")).toHaveLength(1));
    const [drift] = await eventsOfType(doc, "plan_drifted");
    expect(drift).toMatchObject({ revision: 1, diffSummary: "+1 -0 lines at L7" });
  });

  it("accepts drift explicitly without changing the phase or waking the agent", async () => {
    const { doc, api } = await approvedPlan();
    const accept = () => api.call("POST", doc.route(ROUTES.acceptDrift));
    expect((await accept()).status).toBe(409);

    doc.write(PLAN + "- [ ] Ship it\n");
    await vi.waitFor(async () => expect(await eventsOfType(doc, "plan_drifted")).toHaveLength(1));
    const waiting = doc.wait(1, 300);

    const reply = await accept();
    expect(reply.status).toBe(200);
    expect(reply.body.doc.phase).toBe("approved");
    const state = replay((await doc.state()).events);
    expect(pendingDrift(state)).toEqual([]);
    expect(state.reviews).toHaveLength(1);
    expect((await waiting).status).toBe("pending");
    expect((await accept()).status).toBe(409);
  });

  it("keeps the daemon running while a plan is approved or implementing", async () => {
    const { daemon } = await approvedPlan({ idleMs: 30 });
    let stopped = false;
    void daemon.stopped.then(() => (stopped = true));
    await delay(200);
    expect(stopped).toBe(false);
  });

  it("classifies edits made while the daemon was down when it starts", async () => {
    const { doc, daemon, home } = await approvedPlan();
    await daemon.stop();
    doc.write(PLAN.replace("- [ ] Build", "- [x] Build"));

    await startTestDaemon({ home });
    // Read the log directly: no request has touched the document since the restart.
    expect(loggedTypes(home, doc)).toEqual([
      "revision_published",
      "review_submitted",
      "step_checked",
    ]);
  });

  it("does not record the same drift again after a restart", async () => {
    const { doc, daemon, home } = await approvedPlan();
    doc.write(PLAN + "- [ ] Ship it\n");
    await vi.waitFor(async () => expect(await eventsOfType(doc, "plan_drifted")).toHaveLength(1));
    await daemon.stop();
    doc.write(PLAN.replace("- [ ] Build", "- [x] Build") + "- [ ] Ship it\n");

    await startTestDaemon({ home });
    expect(loggedTypes(home, doc).filter((t) => t === "plan_drifted")).toHaveLength(1);
  });

  it("ignores disk edits before approval (they are unpublished changes)", async () => {
    const root = tempRepo({ "plan.md": PLAN });
    const t = await startTestDaemon();
    const doc = await t.open(`${root}/plan.md`);
    await doc.publish();
    const stream = await fetch(t.api.base + doc.route(ROUTES.events));
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();

    doc.write(PLAN.replace("- [ ] Build", "- [x] Build"));
    let received = "";
    while (!received.includes("event: content")) received += (await reader.read()).value;
    await reader.cancel();
    expect(received).toContain("[x] Build");
    expect((await doc.state()).events.map((e) => e.type)).toEqual(["revision_published"]);
  });
});

describe("inbox", () => {
  it("delivers implementation-time threads once, then returns nothing", async () => {
    const { doc, api, root } = await approvedPlan();
    const pending = () =>
      api.ok<InboxPendingResponse>("POST", ROUTES.inboxPending, { repo: `${root}/src` });

    expect(await pending()).toEqual({ items: [] });
    await doc.submit({
      revision: 1,
      verdict: "comment",
      opened: [{ kind: "general", body: "Careful with step 2", attachments: [] }],
    });

    const { items } = await pending();
    expect(items).toHaveLength(1);
    expect(items[0]!.doc.relPath).toBe("docs/plans/plan.md");
    expect(items[0]!.payload.threads).toEqual([
      { id: "t1", kind: "general", body: "Careful with step 2" },
    ]);
    expect(await pending()).toEqual({ items: [] });
  });

  it("lists open reviews, optionally for one repo", async () => {
    const { api, open } = await approvedPlan();
    const other = tempRepo({ "spec.md": "# Spec\n" }, "other");
    await (await open(`${other}/spec.md`)).publish();

    const all = await api.ok<InboxResponse>("GET", ROUTES.inbox);
    expect(all.items.map((i) => i.doc.relPath).sort()).toEqual(["docs/plans/plan.md", "spec.md"]);
    const one = await api.ok<InboxResponse>(
      "GET",
      `${ROUTES.inbox}?repo=${encodeURIComponent(other)}`,
    );
    expect(one.items).toMatchObject([
      { doc: { relPath: "spec.md", phase: "drafting" }, lastRevision: 1, lastReview: 0 },
    ]);
  });
});

describe("gate", () => {
  it("blocks a repo while any of its documents is in review and unapproved", async () => {
    const root = tempRepo({ "docs/plans/a.md": "# A\n", "docs/plans/b.md": "# B\n" });
    const t = await startTestDaemon();
    const gate = (query: string) => t.api.ok<GateResponse>("GET", `${ROUTES.gate}?${query}`);
    const repoQuery = `repo=${encodeURIComponent(root)}`;
    expect(await gate(repoQuery)).toEqual({ approved: true, blocking: [] });

    const a = await t.open(`${root}/docs/plans/a.md`);
    const b = await t.open(`${root}/docs/plans/b.md`);
    await a.publish();
    await b.publish();
    await a.submit({ revision: 1, verdict: "approved" });
    await b.submit({ revision: 1, verdict: "changes_requested" });

    expect(await gate(repoQuery)).toMatchObject({
      approved: false,
      blocking: [{ doc: { relPath: "docs/plans/b.md" }, phase: "in_review" }],
    });
    expect(await gate(`path=${encodeURIComponent(a.file)}`)).toEqual({
      approved: true,
      blocking: [],
    });
    expect(
      (await t.api.call("GET", `${ROUTES.gate}?path=${encodeURIComponent(`${root}/x.md`)}`)).status,
    ).toBe(404);

    await b.submit({ revision: 1, verdict: "approved" });
    expect(await gate(repoQuery)).toEqual({ approved: true, blocking: [] });
  });
});

import { describe, expect, it } from "vitest";
import { ROUTES } from "../../src/core/api.js";
import { replay } from "../../src/core/reducer.js";
import type { Draft } from "../../src/core/types.js";
import { startTestDaemon, tempRepo } from "./helpers.js";

const PLAN = [
  "# Plan",
  "",
  "Intro paragraph.",
  "",
  "## Caching",
  "",
  "Sessions use cache invalidation via TTL only.",
  "",
].join("\n");

async function setup(content = PLAN) {
  const root = tempRepo({ "docs/plan.md": content });
  const t = await startTestDaemon();
  const doc = await t.open(`${root}/docs/plan.md`);
  return { ...t, root, doc };
}

describe("review round", () => {
  it("publishes, waits, and delivers the submitted review with lines on disk", async () => {
    const { doc } = await setup();
    const published = await doc.publish({ summary: "first draft" });
    expect(published).toMatchObject({ created: true, lastReview: 0, revision: { n: 1 } });

    const waiting = doc.wait(published.lastReview);
    const anchor = doc.anchor(PLAN, "cache invalidation via TTL only", 1);
    const review = await doc.submit({
      revision: 1,
      summary: "Needs work",
      opened: [{ kind: "comment", anchor, body: "Write-through?", attachments: [] }],
    });
    expect(review).toMatchObject({ n: 1, revision: 1, opened: ["t1"] });

    const thread = {
      id: "t1",
      kind: "comment",
      at: "L7",
      quote: "cache invalidation via TTL only",
      body: "Write-through?",
    };
    expect(await waiting).toEqual({
      status: "delivered",
      payload: {
        verdict: "changes_requested",
        review: 1,
        revision: 1,
        summary: "Needs work",
        threads: [thread],
        next: "zenspec review docs/plan.md -r <id>:<edited|answered|declined>[:note]",
      },
    });

    // Lines refer to the file on disk at delivery time, not to the reviewed revision.
    doc.write(PLAN.replace("Intro paragraph.", "Intro paragraph.\n\nAnother one."));
    const late = await doc.wait(0);
    expect(late.status === "delivered" && late.payload.threads).toEqual([{ ...thread, at: "L9" }]);

    const next = await doc.publish({ responses: [{ thread: "t1", action: "edited" }] });
    expect(next).toMatchObject({ created: true, revision: { n: 2 }, lastReview: 1 });
    const state = replay((await doc.state()).events);
    expect(state.threads.t1?.status).toBe("addressed");
  });

  it("delivers the same review to every waiter", async () => {
    const { doc } = await setup();
    await doc.publish();
    const waiters = [doc.wait(0), doc.wait(0), doc.wait(0)];
    await doc.submit({
      revision: 1,
      verdict: "comment",
      opened: [{ kind: "general", body: "Add rollback", attachments: [] }],
    });
    const replies = await Promise.all(waiters);
    expect(replies.map((r) => r.status)).toEqual(["delivered", "delivered", "delivered"]);
    expect(replies[1]).toEqual(replies[0]);
    expect(replies[2]).toEqual(replies[0]);
    // A late waiter still gets it: nothing was drained.
    expect(await doc.wait(0)).toEqual(replies[0]);
  });

  it("returns a pending payload when the wait times out", async () => {
    const { doc } = await setup();
    await doc.publish();
    expect(await doc.wait(0, 20)).toEqual({
      status: "pending",
      payload: { verdict: "pending", next: "zenspec review docs/plan.md --wait 20ms" },
    });
  });

  it("treats an unchanged file without responses as a no-op", async () => {
    const { doc } = await setup();
    const first = await doc.publish({ summary: "one" });
    const again = await doc.publish({ summary: "two" });
    expect(again).toEqual({ ...first, created: false });
    expect((await doc.state()).events).toHaveLength(1);
  });

  it("wakes waiters with `closed` when the session is closed", async () => {
    const { doc, api } = await setup();
    await doc.publish();
    const waiting = doc.wait(0);
    await api.ok("POST", doc.route(ROUTES.close), { reason: "abandoned" });
    expect(await waiting).toEqual({ status: "closed", by: "agent", reason: "abandoned" });
    const stale = await api.call("POST", doc.route(ROUTES.reviews), {
      revision: 1,
      verdict: "approved",
      summary: "",
      opened: [],
      reopened: [],
      resolved: [],
    });
    expect(stale.status).toBe(409);
  });
});

describe("re-anchoring on publish", () => {
  it("records placements, moving threads whose text is gone to outdated", async () => {
    const text = `${PLAN}## Security\n\nRotate keys monthly.\n`;
    const { doc } = await setup(text);
    await doc.publish();
    await doc.submit({
      revision: 1,
      opened: [
        {
          kind: "comment",
          anchor: doc.anchor(text, "cache invalidation", 1),
          body: "a",
          attachments: [],
        },
        { kind: "comment", anchor: doc.anchor(text, "Rotate keys", 1), body: "b", attachments: [] },
      ],
    });

    doc.write(
      text.replace("Intro paragraph.", "Intro.\n\nMore intro.").replace(/## Security[^]*/, ""),
    );
    await doc.publish({ summary: "moved things" });

    const { events } = await doc.state();
    const state = replay(events);
    expect(state.threads.t1).toMatchObject({ status: "open", placement: { revision: 2 } });
    expect(state.threads.t1?.placement?.lines).toEqual([9, 9]);
    expect(state.threads.t2).toMatchObject({ status: "outdated", placement: { strategy: 6 } });
  });
});

describe("draft", () => {
  it("survives a restart and marks items whose text disappeared as orphaned", async () => {
    const { doc, api, home, daemon, root } = await setup();
    await doc.publish();
    const draft: Draft = {
      revision: 1,
      summary: "wip",
      threads: [
        {
          draftId: "d1",
          kind: "comment",
          anchor: doc.anchor(PLAN, "Intro paragraph", 1),
          body: "keep",
          attachments: [],
        },
        {
          draftId: "d2",
          kind: "comment",
          anchor: doc.anchor(PLAN, "TTL only", 1),
          body: "gone soon",
          attachments: [],
        },
      ],
      reopen: [],
      resolve: [],
      updatedAt: "",
    };
    await api.ok("PUT", doc.route(ROUTES.draft), draft);
    await daemon.stop();

    const restarted = await startTestDaemon({ home });
    const reopened = await restarted.open(`${root}/docs/plan.md`);
    expect((await reopened.state()).draft).toMatchObject({ summary: "wip", revision: 1 });

    reopened.write("# Plan\n\nIntro paragraph.\n");
    await reopened.publish();
    const { draft: after } = await reopened.state();
    expect(after?.revision).toBe(2);
    expect(after?.threads.map((t) => [t.draftId, t.orphaned ?? false])).toEqual([
      ["d1", false],
      ["d2", true],
    ]);
    // The orphan keeps its original quote.
    expect(after?.threads[1]).toMatchObject({ anchor: { quote: "TTL only" } });
  });

  it("stages resolve/reopen in the draft and clears the draft on submit", async () => {
    const { doc, api } = await setup();
    await doc.publish();
    await doc.submit({
      revision: 1,
      opened: [{ kind: "general", body: "x", attachments: [] }],
    });
    const staged = await api.ok("POST", doc.route(ROUTES.thread, { threadId: "t1" }), {
      action: "resolve",
    });
    expect(staged.draft).toMatchObject({ resolve: ["t1"], reopen: [] });
    const missing = await api.call("POST", doc.route(ROUTES.thread, { threadId: "t9" }), {
      action: "resolve",
    });
    expect(missing.status).toBe(404);

    await doc.submit({ revision: 1, verdict: "approved", resolved: ["t1"] });
    const { draft, events } = await doc.state();
    expect(draft).toBeNull();
    expect(replay(events).threads.t1?.status).toBe("resolved");
  });
});

describe("storage", () => {
  it("replays the log after a restart", async () => {
    const { doc, home, daemon, root } = await setup();
    await doc.publish();
    await doc.submit({
      revision: 1,
      opened: [{ kind: "general", body: "x", attachments: [] }],
    });
    const before = await doc.state();
    await daemon.stop();

    const restarted = await startTestDaemon({ home });
    const again = await restarted.open(`${root}/docs/plan.md`);
    expect(again.docId).toBe(doc.docId);
    expect((await again.state()).events).toEqual(before.events);
    expect(await again.publish()).toMatchObject({ created: false, lastReview: 1 });
    const revision = await restarted.api.call("GET", again.route(ROUTES.revision, { n: 1 }));
    expect(revision).toEqual({ status: 200, body: PLAN });
  });

  it("answers 404 with an ApiError for unknown documents", async () => {
    const { api } = await startTestDaemon();
    const reply = await api.call("GET", "/api/docs/nope-123456/plan-md");
    expect(reply).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "Unknown document: nope-123456/plan-md" } },
    });
  });

  it("stores valid images content-addressed and rejects other bytes", async () => {
    const { doc, api } = await setup();
    // Signature plus an IHDR chunk header: enough for the daemon to read 2x3.
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(3, 20);
    const upload = (body: Buffer, type: string) =>
      fetch(api.base + doc.route(ROUTES.attachments), {
        method: "POST",
        headers: { "Content-Type": type },
        body: new Uint8Array(body),
      });
    const ok = await upload(png, "image/png");
    const ref = await ok.json();
    expect(ref).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      mime: "image/png",
      width: 2,
      height: 3,
    });
    const served = await fetch(api.base + doc.route(ROUTES.attachment, { attachmentId: ref.id }));
    expect(Buffer.from(await served.arrayBuffer())).toEqual(png);
    expect((await upload(Buffer.from("not an image"), "image/png")).status).toBe(400);
  });
});

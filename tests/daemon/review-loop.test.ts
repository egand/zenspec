import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ROUTES } from "../../src/core/api.js";
import { replay } from "../../src/core/reducer.js";
import type { Draft } from "../../src/core/types.js";
import { startTestDaemon, tempRepo, type Doc } from "./helpers.js";

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

describe("replies", () => {
  it("delivers a reply on an open thread to the waiting agent without changing its status", async () => {
    const { doc } = await setup();
    await doc.publish();
    const anchor = doc.anchor(PLAN, "cache invalidation via TTL only", 1);
    await doc.submit({
      revision: 1,
      opened: [{ kind: "comment", anchor, body: "Write-through?", attachments: [] }],
    });

    const waiting = doc.wait(1);
    const review = await doc.submit({
      revision: 1,
      verdict: "comment",
      replies: [{ thread: "t1", body: "And what about stampedes?" }],
    });
    expect(review).toMatchObject({ n: 2, replied: ["t1"], opened: [], reopened: [] });
    const delivered = await waiting;
    expect(delivered).toMatchObject({
      status: "delivered",
      payload: {
        verdict: "comment",
        threads: [{ id: "t1", kind: "comment", at: "L7", body: "And what about stampedes?" }],
      },
    });
    const state = replay((await doc.state()).events);
    expect(state.threads.t1?.status).toBe("open");
    expect(state.threads.t1?.messages.map((m) => m.action)).toEqual(["comment", "reply"]);
  });

  it("delivers a reply on an addressed or declined thread with its status", async () => {
    const { doc } = await setup();
    await doc.publish();
    const general = (body: string) => ({ kind: "general" as const, body, attachments: [] });
    await doc.submit({ revision: 1, opened: [general("Why?"), general("And this?")] });
    await doc.publish({
      responses: [
        { thread: "t1", action: "answered", note: "Because." },
        { thread: "t2", action: "declined", note: "Out of scope." },
      ],
    });

    const review = await doc.submit({
      revision: 1,
      verdict: "comment",
      replies: [
        { thread: "t1", body: "Because of what?" },
        { thread: "t2", body: "It is in scope." },
      ],
    });
    expect(review.replied).toEqual(["t1", "t2"]);
    expect(await doc.wait(1)).toEqual({
      status: "delivered",
      payload: {
        verdict: "comment",
        review: 2,
        revision: 1,
        threads: [
          {
            id: "t1",
            replied: true,
            status: "addressed",
            kind: "general",
            body: "Because of what?",
          },
          { id: "t2", replied: true, status: "declined", kind: "general", body: "It is in scope." },
        ],
        next: "zenspec review docs/plan.md -r <id>:<edited|answered|declined>[:note]",
      },
    });
  });
});

describe("delivered cursor", () => {
  it("delivers a review submitted between waits to the next wait, then waits for a newer one", async () => {
    const { doc } = await setup();
    await doc.publish();
    expect((await doc.wait(undefined, 20)).status).toBe("pending");
    await doc.submit({ revision: 1, opened: [{ kind: "general", body: "x", attachments: [] }] });

    const late = await doc.wait(undefined, 20);
    expect(late).toMatchObject({ status: "delivered", payload: { review: 1 } });
    expect((await doc.wait(undefined, 20)).status).toBe("pending");
  });

  it("gives concurrent waiters the same review and advances the cursor once", async () => {
    const { doc, daemon, home, root } = await setup();
    await doc.publish();
    const waiters = [doc.wait(), doc.wait()];
    await vi.waitFor(async () => expect((await doc.state()).presence.waiting).toBe(2));
    await doc.submit({ revision: 1, verdict: "comment" });
    const [a, b] = await Promise.all(waiters);
    expect(a).toMatchObject({ status: "delivered", payload: { review: 1 } });
    expect(b).toEqual(a);

    // The cursor survives a restart.
    await daemon.stop();
    const restarted = await startTestDaemon({ home });
    const again = await restarted.open(`${root}/docs/plan.md`);
    expect((await again.wait(undefined, 20)).status).toBe("pending");
  });

  it("does not advance the cursor when the waiter disconnects before delivery", async () => {
    const { doc, api } = await setup();
    await doc.publish();
    const abort = new AbortController();
    const gone = fetch(api.base + doc.route(ROUTES.nextReview), { signal: abort.signal }).catch(
      () => undefined,
    );
    await vi.waitFor(async () => expect((await doc.state()).presence.waiting).toBe(1));
    abort.abort();
    await gone;
    await vi.waitFor(async () => expect((await doc.state()).presence.waiting).toBe(0));
    await doc.submit({ revision: 1, verdict: "comment" });
    expect(await doc.wait(undefined, 20)).toMatchObject({ status: "delivered" });
  });
});

describe("closed sessions", () => {
  it("reopens when the agent publishes the unchanged file again", async () => {
    const { doc, api } = await setup();
    await doc.publish();
    await api.ok("POST", doc.route(ROUTES.close), {});
    expect(await doc.wait(undefined, 20)).toMatchObject({ status: "closed" });

    expect(await doc.publish()).toMatchObject({ created: false });
    const state = replay((await doc.state()).events);
    expect(state.closed).toBeUndefined();
    expect((await doc.state()).events.map((e) => e.type)).toEqual([
      "revision_published",
      "session_closed",
      "session_reopened",
    ]);
    expect((await doc.wait(undefined, 20)).status).toBe("pending");
  });
});

describe("agent presence", () => {
  it("reports waiters in the state and over SSE", async () => {
    const { doc, api } = await setup();
    const before = (await doc.state()).presence;
    expect(before).toEqual({ waiting: 0 });

    const stream = await fetch(api.base + doc.route(ROUTES.events));
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    await doc.publish();
    const waiting = doc.wait(0);
    let received = "";
    while (!received.includes('"waiting":1')) received += (await reader.read()).value;
    await reader.cancel();
    expect(received).toContain("event: presence");

    const { presence } = await doc.state();
    expect(presence.waiting).toBe(1);
    expect(Date.now() - Date.parse(presence.agentSeenAt!)).toBeLessThan(10_000);

    await doc.submit({ revision: 1, verdict: "comment" });
    await waiting;
    expect((await doc.state()).presence.waiting).toBe(0);
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
      replies: [],
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

  it("clears the draft on submit", async () => {
    const { doc, api } = await setup();
    await doc.publish();
    await doc.submit({
      revision: 1,
      opened: [{ kind: "general", body: "x", attachments: [] }],
    });
    const staged: Draft = {
      revision: 1,
      summary: "",
      threads: [],
      reopen: [],
      replies: [],
      resolve: ["t1"],
      updatedAt: "",
    };
    expect((await api.ok("PUT", doc.route(ROUTES.draft), staged)).draft).toMatchObject({
      resolve: ["t1"],
    });

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
    const png = pngHeader(2, 3);
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

  it("rejects images over 1568 px on the long edge", async () => {
    const { doc, api } = await setup();
    const reply = await fetch(api.base + doc.route(ROUTES.attachments), {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(pngHeader(1569, 10)),
    });
    expect(reply.status).toBe(413);
    expect((await reply.json()).error.message).toMatch(/1568/);
  });

  it("checks submitted attachments against the store and takes their size from the file", async () => {
    const { doc, api } = await setup();
    await doc.publish();
    const uploaded = await fetch(api.base + doc.route(ROUTES.attachments), {
      method: "POST",
      body: new Uint8Array(pngHeader(4, 5)),
    }).then((r) => r.json());
    const general = (attachments: unknown[]) => ({
      kind: "general",
      body: "see image",
      attachments,
    });
    const submit = (attachments: unknown[]) =>
      api.call("POST", doc.route(ROUTES.reviews), {
        revision: 1,
        verdict: "comment",
        summary: "",
        opened: [general(attachments)],
        reopened: [],
        resolved: [],
      });

    const bogus = { id: "../../etc/passwd", mime: "image/png", width: 1, height: 1 };
    expect((await submit([bogus])).status).toBe(400);
    const missing = { id: "0123456789ab", mime: "image/png", width: 1, height: 1 };
    expect((await submit([missing])).status).toBe(400);

    const lying = { ...uploaded, width: 9999, height: 1 };
    expect((await submit([lying])).status).toBe(200);
    const state = replay((await doc.state()).events);
    expect(state.threads.t1?.messages[0]?.attachments).toEqual([uploaded]);
  });

  it("serves HTML revisions sandboxed and never sniffed", async () => {
    const root = tempRepo({ "mock.html": "<h1>Hi</h1><script>1</script>" });
    const t = await startTestDaemon();
    const doc = await t.open(`${root}/mock.html`);
    await doc.publish();
    const res = await fetch(t.api.base + doc.route(ROUTES.revision, { n: 1 }));
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("<h1>Hi</h1><script>1</script>");
  });

  it("truncates a torn last line of the log so later appends stay parseable", async () => {
    const { doc, home, daemon, root } = await setup();
    await doc.publish();
    await daemon.stop();
    const log = path.join(docDir(home, doc), "events.jsonl");
    fs.appendFileSync(log, '{"schemaVersion":1,"type":"review_sub');

    const restarted = await startTestDaemon({ home });
    const again = await restarted.open(`${root}/docs/plan.md`);
    await again.submit({ revision: 1, verdict: "comment" });
    const lines = fs.readFileSync(log, "utf8").trimEnd().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      "revision_published",
      "review_submitted",
    ]);
  });
});

/** Signature plus an IHDR chunk header: enough for the daemon to read the size. */
function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function docDir(home: string, doc: Doc): string {
  return path.join(home, "repos", doc.repoId, "docs", doc.docId);
}

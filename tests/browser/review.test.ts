/** Browser E2E: submitting reviews, thread actions, revision diffs, and living plans (§9, §10). */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PLAN,
  clickText,
  compose,
  openPage,
  openTab,
  selectText,
  setup,
  submitReview,
  threadsOf,
  until,
  useBrowser,
  waitForText,
} from "./harness.js";

useBrowser();

const card = (id: string) => `.zen-thread-card[data-id="${id}"]`;

describe("reviews and threads", () => {
  it("submits a verdict, then resolves one thread and reopens another", async () => {
    const f = await setup();
    const { page, doc } = f;
    await openPage(f);

    await selectText(page, "one hour TTL");
    await compose(page, "Why one hour?");
    await selectText(page, "LRU policy");
    await compose(page, "Consider LFU");
    await submitReview(page, "changes_requested", "Two concerns");

    // The dialog switches to the Threads tab once the review is in.
    await page.waitForFunction(
      () => document.querySelectorAll(".zen-thread-card.status-open").length === 2,
    );
    const { events } = await doc.state();
    expect(events.find((e) => e.type === "review_submitted")).toMatchObject({
      verdict: "changes_requested",
      summary: "Two concerns",
    });
    const [ttl, lru] = await threadsOf(doc);
    expect([ttl!.messages[0]!.body, lru!.messages[0]!.body]).toEqual([
      "Why one hour?",
      "Consider LFU",
    ]);

    // The agent edits the TTL line and declines the LRU comment.
    fs.writeFileSync(f.file, PLAN.replace("one hour TTL", "15 minute TTL"));
    await doc.publish({
      summary: "Shorter TTL",
      responses: [
        { thread: ttl!.id, action: "edited" },
        { thread: lru!.id, action: "declined", note: "LRU is enough here" },
      ],
    });
    await page.waitForSelector(`${card(ttl!.id)}.status-addressed`);
    await page.waitForSelector(`${card(lru!.id)}.status-declined`);
    await waitForText(page, `${card(lru!.id)} .zen-message`, "LRU is enough here");

    await clickText(page, `${card(ttl!.id)} button`, "Resolve");
    await waitForText(page, `${card(ttl!.id)} .zen-staged`, "Resolve staged");
    await clickText(page, `${card(lru!.id)} button`, "Reopen");
    await page.waitForSelector(`${card(lru!.id)} .zen-staged`);
    await submitReview(page, "comment");

    await page.waitForSelector(`${card(ttl!.id)}.status-resolved`);
    await page.waitForSelector(`${card(lru!.id)}.status-open`);
    expect(await page.$(`${card(ttl!.id)} .zen-card-actions`)).toBeNull();
    const statuses = Object.fromEntries((await threadsOf(doc)).map((t) => [t.id, t.status]));
    expect(statuses).toEqual({ [ttl!.id]: "resolved", [lru!.id]: "open" });
  });
});

describe("revisions", () => {
  it("shows the diff between two revisions in the document view", async () => {
    const f = await setup();
    const { page, doc } = f;
    fs.writeFileSync(
      f.file,
      PLAN.replace("one hour TTL", "15 minute TTL").replace(
        "## Steps",
        "Hot keys are pinned.\n\n## Steps",
      ),
    );
    await doc.publish({ summary: "Tune the cache" });
    await openPage(f);
    expect(await page.$(".zen-diff-mark")).toBeNull();

    await openTab(page, "Revisions");
    await clickText(page, ".zen-timeline button", "Diff with r1");
    await waitForText(page, ".zen-compare-note", "Showing r2 with changes since r1.");
    await page.waitForSelector(".zen-diff-mark.zen-diff-added");
    await page.waitForSelector(".zen-diff-mark.zen-diff-modified");
    await waitForText(page, ".zen-doc-body", "Hot keys are pinned.");

    await clickText(page, ".zen-revision-actions button", "Back to live");
    await page.waitForFunction(() => !document.querySelector(".zen-diff-mark"));
  });
});

describe("living plans", () => {
  it("tracks step progress after approval when a checkbox is ticked on disk", async () => {
    const plan = PLAN.replace(/> \[!QUESTION\][^]*?SQLite\n\n/, "");
    const f = await setup(plan);
    const { page, doc } = f;
    await openPage(f);
    expect(await page.$(".zen-progress")).toBeNull();

    await submitReview(page, "approved");
    await page.waitForSelector(".zen-phase-approved");
    await waitForText(page, ".zen-progress-label", "0/3 steps · next: Add the Redis client");

    fs.writeFileSync(
      f.file,
      plan.replace("- [ ] Add the Redis client", "- [x] Add the Redis client"),
    );
    await waitForText(page, ".zen-progress-label", "1/3 steps · next: Write the cache layer");
    expect(await page.$eval(".zen-progress-fill", (el) => (el as HTMLElement).style.width)).toBe(
      "33%",
    );
    expect(await page.$(".zen-banner-warn")).toBeNull();
    await until(async () => (await doc.state()).content.includes("[x] Add the Redis client"));
  });
});

/** Browser E2E: the reviewer's draft, question answers, and pasted images (plan §9.1, §9.2). */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PLAN,
  clickText,
  compose,
  openPage,
  selectText,
  setup,
  submitReview,
  threadsOf,
  until,
  useBrowser,
  waitForLive,
  waitForText,
} from "./harness.js";

useBrowser();

describe("draft", () => {
  it("survives a reload and an agent edit that publishes a new revision", async () => {
    const f = await setup();
    const { page, doc } = f;
    await openPage(f);

    await selectText(page, "one hour TTL");
    await compose(page, "Why one hour?");
    await waitForText(page, ".zen-card blockquote", "one hour TTL");
    await until(async () => (await doc.state()).draft?.threads.length === 1);

    await page.reload();
    await waitForLive(page);
    await waitForText(page, ".zen-card .zen-body", "Why one hour?");
    await page.waitForSelector(".zen-hl");

    // The agent inserts a section above the comment and publishes revision 2.
    const edited = PLAN.replace("## Caching", "## Goals\n\nFaster logins.\n\n## Caching");
    fs.writeFileSync(f.file, edited);
    await doc.publish({ summary: "Add goals" });
    await waitForText(page, ".zen-topbar .zen-chip", "r2");

    await waitForText(page, ".zen-card .zen-body", "Why one hour?");
    expect(await page.$(".zen-card.orphaned")).toBeNull();
    await page.waitForSelector(".zen-hl");
    const { draft } = await doc.state();
    expect(draft).toMatchObject({ revision: 2, threads: [{ body: "Why one hour?" }] });
    const line = edited.split("\n").findIndex((l) => l.includes("one hour TTL")) + 1;
    expect(draft!.threads[0]!.placement).toMatchObject({ revision: 2, lines: [line, line] });
  });

  it("pastes a large image into the composer as a downscaled attachment", async () => {
    const f = await setup();
    const { page, doc } = f;
    await openPage(f);

    await clickText(page, ".zen-panel-footer button", "General comment");
    await page.waitForSelector(".zen-modal textarea");
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 3000;
      canvas.height = 2000;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#3a7";
      ctx.fillRect(0, 0, 3000, 2000);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
      const data = new DataTransfer();
      data.items.add(new File([blob], "screenshot.png", { type: "image/png" }));
      const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true });
      document.querySelector(".zen-modal textarea")!.dispatchEvent(paste);
    });

    const thumb = await page.waitForSelector(".zen-modal .zen-thumb-open");
    expect(await thumb!.evaluate((el) => el.getAttribute("title"))).toBe("1568×1045");
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>(".zen-modal .zen-thumb img");
      return img?.complete && img.naturalWidth === 1568;
    });
    await compose(page, "See the screenshot");

    const draft = await until(async () => (await doc.state()).draft);
    expect(draft.threads[0]).toMatchObject({
      kind: "general",
      body: "See the screenshot",
      attachments: [{ mime: "image/png", width: 1568, height: 1045 }],
    });
  });
});

describe("questions", () => {
  it("never pre-selects the recommended option, and locks the card once submitted", async () => {
    const f = await setup();
    const { page, doc } = f;
    await openPage(f);

    const card = ".zen-question";
    await waitForText(page, `${card} .zen-option.is-recommended`, "PostgreSQL");
    await waitForText(page, `${card} .zen-question-hint`, "Recommended: PostgreSQL");
    expect(await page.$$eval(`${card} input:checked`, (els) => els.length)).toBe(0);
    expect(await page.$(`${card}.is-draft`)).toBeNull();
    const draftTab = await page.$eval(".zen-tabs button[role=tab]", (tab) => tab.textContent);
    expect(draftTab).toBe("Draft");
    expect((await doc.state()).draft?.threads ?? []).toEqual([]);

    await clickText(page, `${card} .zen-option`, "SQLite");
    await page.waitForSelector(`${card}.is-draft`);
    await until(async () => (await doc.state()).draft?.threads.length === 1);

    await submitReview(page, "comment");
    await page.waitForSelector(`${card}.is-locked`);
    await waitForText(page, `${card} .zen-question-answered`, "Answered");
    const inputs = await page.$$eval(`${card} input`, (els) =>
      els.map((el) => ({ disabled: (el as HTMLInputElement).disabled })),
    );
    expect(inputs.every((i) => i.disabled)).toBe(true);
    expect(await threadsOf(doc)).toMatchObject([
      { kind: "decision", choice: { mode: "single", option: "SQLite" } },
    ]);
  });
});

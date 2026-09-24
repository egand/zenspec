/**
 * Browser E2E harness: one headless Chrome per test file, and per test a real daemon (temp
 * `ZENSPEC_HOME`, port 0), a temp git repo holding a plan, and a page on the built client.
 * Every wait is on a DOM or API condition, never a fixed delay.
 */
import path from "node:path";
import { afterAll, afterEach, beforeAll, onTestFinished } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { replay, threadList } from "../../src/core/reducer.js";
import type { Thread } from "../../src/core/types.js";
import { startTestDaemon, tempRepo, type Doc } from "../daemon/helpers.js";

export const PLAN = [
  "# Session cache plan",
  "",
  "## Caching",
  "",
  "Sessions are cached in Redis with a one hour TTL.",
  "",
  "Eviction uses an LRU policy with a 10k entry cap.",
  "",
  "> [!QUESTION] Which database?",
  "> - PostgreSQL (Recommended)",
  "> - SQLite",
  "",
  "## Steps",
  "",
  "- [ ] Add the Redis client",
  "- [ ] Write the cache layer",
  "- [ ] Ship it",
  "",
].join("\n");

let browser: Browser;
const pageErrors: string[] = [];

export function useBrowser(): void {
  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      // GitHub's Ubuntu runners can't use Chrome's sandbox.
      args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  afterEach(() => {
    const errors = pageErrors.splice(0);
    if (errors.length) throw new Error(`Uncaught errors in the page:\n${errors.join("\n")}`);
  });
}

export interface Fixture {
  doc: Doc;
  page: Page;
  url: string;
  file: string;
}

/** A daemon and a repo with `plan.md`, published as revision 1, and a page not yet opened. */
export async function setup(content = PLAN): Promise<Fixture> {
  const { daemon, open } = await startTestDaemon();
  const root = tempRepo({ "plan.md": content });
  const file = path.join(root, "plan.md");
  const doc = await open(file);
  await doc.publish({ summary: "First draft" });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  onTestFinished(() => page.close().catch(() => {}));
  const url = `${daemon.url}/d/${encodeURIComponent(doc.repoId)}/${encodeURIComponent(doc.docId)}`;
  return { doc, page, url, file };
}

/** Loads the review page and waits until the document is rendered and the SSE stream is open. */
export async function openPage({ page, url }: Fixture): Promise<void> {
  await page.goto(url);
  await waitForLive(page);
}

export async function waitForLive(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      !!document.querySelector(".zen-doc-body [data-block-id]") &&
      ![...document.querySelectorAll(".zen-chip-muted")].some((c) =>
        c.textContent?.includes("reconnecting"),
      ),
  );
}

/** Waits for an element matching `selector` whose text contains `text`. */
export async function waitForText(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    (sel, t) => [...document.querySelectorAll(sel)].some((el) => el.textContent?.includes(t)),
    {},
    selector,
    text,
  );
}

/** Clicks the first `selector` element whose text contains `text`. */
export async function clickText(page: Page, selector: string, text: string): Promise<void> {
  await waitForText(page, selector, text);
  await page.evaluate(
    (sel, t) => {
      const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) =>
        e.textContent?.includes(t),
      );
      el!.click();
    },
    selector,
    text,
  );
}

/** Selects `quote` in the rendered document like a mouse drag, then picks a toolbar action. */
export async function selectText(page: Page, quote: string, action = "comment"): Promise<void> {
  await page.evaluate((q) => {
    const body = document.querySelector(".zen-doc-body")!;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(q);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + q.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      node.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
    throw new Error(`Text not found: ${q}`);
  }, quote);
  const button = await page.waitForSelector(`.zen-sel-toolbar button[data-action="${action}"]`);
  await button!.click();
}

/** Types into the open composer and adds the item to the draft. */
export async function compose(page: Page, body: string): Promise<void> {
  const field = await page.waitForSelector(".zen-modal textarea.zen-textarea");
  await field!.type(body);
  await clickText(page, ".zen-modal button[type=submit]", "Add to review");
  await page.waitForFunction(() => !document.querySelector(".zen-modal"));
}

/** Opens the submit dialog, picks a verdict, and submits. */
export async function submitReview(page: Page, verdict: string, summary = ""): Promise<void> {
  await clickText(page, ".zen-topbar button", "Submit review");
  await page.waitForSelector(`.zen-modal input[name=verdict][value=${verdict}]`);
  await page.click(`.zen-modal input[name=verdict][value=${verdict}]`);
  if (summary) await page.type(".zen-modal textarea", summary);
  await page.click(".zen-modal button[type=submit]");
  // Unanswered questions get one prompt; these tests leave them unanswered.
  const prompted = await page.waitForFunction(() => {
    const modal = document.querySelector(".zen-modal");
    return !modal ? "closed" : modal.getAttribute("aria-label") === "Unanswered questions";
  });
  if ((await prompted.jsonValue()) === true) {
    await clickText(page, ".zen-modal button", "Leave unanswered");
    await page.waitForFunction(() => !document.querySelector(".zen-modal"));
  }
}

export async function openTab(page: Page, label: string): Promise<void> {
  await clickText(page, ".zen-tabs button[role=tab]", label);
}

/** Polls the daemon until `check` returns a value (for state the page saves asynchronously). */
export async function until<T>(check: () => Promise<T | undefined | null | false>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Condition not met within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The document's threads, as the daemon's event log reduces them. */
export async function threadsOf(doc: Doc): Promise<Thread[]> {
  return threadList(replay((await doc.state()).events));
}

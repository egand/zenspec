/**
 * End-to-End Real Browser Automation Test with Puppeteer
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import puppeteer, { Browser, Page } from "puppeteer";
import { ZenServer } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";

describe("Zen AXI Real Browser End-to-End Test Suite", { timeout: 25000 }, () => {
  let server: ZenServer;
  let store: SessionStore;
  let port: number;
  let browser: Browser;
  let page: Page;
  let testFile: string;
  let testKey: string;

  beforeAll(async () => {
    // 1. Create temporary Markdown document
    testFile = path.join(os.tmpdir(), `zen-e2e-${Date.now()}.md`);
    const content = `# Zen Architecture Plan

This is a high-performance review system.

## 1. Overview
The agent and human collaborate seamlessly.

\`\`\`mermaid
sequenceDiagram
  Agent->>Server: Poll
  Human->>Browser: Annotate
  Browser->>Server: Send
\`\`\`

## 2. Technical Questions
> [!QUESTION] Which database should we use?
> - [x] PostgreSQL
> - [ ] SQLite Embedded

## 3. Mathematical Foundations
The formula is: $$\\eta = 1 - \\frac{\\text{Tokens}_{\\text{Markdown}}}{\\text{Tokens}_{\\text{HTML}}} \\approx 0.72$$
`;
    fs.writeFileSync(testFile, content, "utf-8");

    // 2. Start server on dynamic port
    store = new SessionStore();
    const session = store.getOrCreateSession(testFile);
    testKey = session.key;

    server = new ZenServer({ port: 0, store });
    await server.start();
    port = server.port;

    // 3. Launch Puppeteer browser
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
  });

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  });

  it("loads the review session and renders Markdown, KaTeX, and Mermaid", async () => {
    const url = `http://127.0.0.1:${port}/session/${testKey}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Wait for async document loading and rendering to complete
    await page.waitForSelector(".zen-document-container h1", { timeout: 10000 });
    await page.waitForSelector(".katex-display", { timeout: 10000 });
    await page.waitForSelector(".zen-mermaid-container", { timeout: 10000 });
    await page.waitForSelector(".zen-option-card", { timeout: 10000 });

    // Verify Title & Brand
    const brand = await page.$eval(".zen-title", (el) => el.textContent);
    expect(brand).toBe("Zen AXI");

    // Verify KaTeX Display Math is rendered
    const katexEl = await page.$(".katex-display");
    expect(katexEl).not.toBeNull();

    // Verify Mermaid container exists
    const mermaidContainer = await page.$(".zen-mermaid-container");
    expect(mermaidContainer).not.toBeNull();

    // Verify Question Card rendered
    const questionCard = await page.$(".zen-callout-question");
    expect(questionCard).not.toBeNull();

    // Capture screenshot of top half
    const screenshotPath = path.resolve("tests/screenshots/verified-review-ui.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });

    // Scroll down .zen-canvas to Section 3 and capture KaTeX math and Question cards
    await page.evaluate(() => {
      const c = document.querySelector(".zen-canvas");
      if (c) c.scrollTop = c.scrollHeight;
    });
    const mathScreenshotPath = path.resolve("tests/screenshots/verified-math-and-questions.png");
    await page.screenshot({ path: mathScreenshotPath, fullPage: false });
  });

  it("interactively selects question option cards and queues feedback", async () => {
    // Wait for option cards to be ready (2 predefined + 1 custom write-in)
    await page.waitForSelector(".zen-option-card", { timeout: 10000 });
    const optionCards = await page.$$(".zen-option-card");
    expect(optionCards.length).toBe(3);

    // Click on the second option: SQLite Embedded
    await optionCards[1].click();

    // Wait for queue count to update to 1
    await page.waitForFunction(
      () => {
        const countEl = document.getElementById("zen-queue-count");
        return countEl && countEl.textContent === "1";
      },
      { timeout: 10000 },
    );

    const queueCount = await page.$eval("#zen-queue-count", (el) => el.textContent);
    expect(queueCount).toBe("1");

    const queueCardText = await page.$eval(".zen-queue-card-text", (el) => el.textContent);
    expect(queueCardText).toContain("SQLite Embedded");
  });

  it("adds general note in composer and submits all queued prompts to agent", async () => {
    // Add note in composer
    await page.type("#zen-composer-input", "Please proceed with SQLite implementation.");
    await page.keyboard.press("Enter");

    // Queue count should be 2 (1 question answer + 1 note)
    await page.waitForFunction(
      () => {
        const countEl = document.getElementById("zen-queue-count");
        return countEl && countEl.textContent === "2";
      },
      { timeout: 10000 },
    );

    // Click Send to Agent button
    await page.click("#zen-send-btn");

    // Queue count should reset to 0
    await page.waitForFunction(
      () => {
        const countEl = document.getElementById("zen-queue-count");
        return countEl && countEl.textContent === "0";
      },
      { timeout: 10000 },
    );

    // Verify server session store received the prompts
    const session = store.getSession(testKey);
    expect(session).not.toBeNull();
    expect(session?.presence).toBe("waiting");
  });
});

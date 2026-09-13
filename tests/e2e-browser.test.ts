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

describe("ZenSpec Real Browser End-to-End Test Suite", { timeout: 35000 }, () => {
  let server: ZenServer;
  let store: SessionStore;
  let port: number;
  let browser: Browser;
  let page: Page;
  let testDir: string;
  let testFile: string;
  let secondFile: string;
  let testKey: string;

  beforeAll(async () => {
    // 1. Create dedicated temporary workspace directory
    testDir = path.join(os.tmpdir(), `zen-e2e-suite-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    testFile = path.join(testDir, "plan.md");
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

    secondFile = path.join(testDir, "rfc.md");
    fs.writeFileSync(
      secondFile,
      "# Secondary RFC Document\n\nThis is a second document in the workspace.\n\n## Details\nFull specifications here.\n",
      "utf-8",
    );

    // 2. Start server on dynamic port with workspaceRoot
    store = new SessionStore();
    const session = store.getOrCreateSession(testFile);
    session.workspaceRoot = testDir;
    testKey = session.key;

    // Create session for second file as well
    const session2 = store.getOrCreateSession(secondFile);
    session2.workspaceRoot = testDir;

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
  }, 30000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }, 30000);

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
    expect(brand).toBe("ZenSpec");

    // Verify KaTeX Display Math is rendered
    const katexEl = await page.$(".katex-display");
    expect(katexEl).not.toBeNull();

    // Verify Mermaid container exists
    const mermaidContainer = await page.$(".zen-mermaid-container");
    expect(mermaidContainer).not.toBeNull();

    // Verify Question Card rendered
    const questionCard = await page.$(".zen-callout-question");
    expect(questionCard).not.toBeNull();
  });

  it("interactively zooms, resets, and opens fullscreen lightbox for Mermaid diagrams", async () => {
    await page.waitForSelector(".zen-mermaid-container", { timeout: 10000 });
    await page.waitForSelector(".zen-diagram-zoom-controls", { timeout: 10000 });

    // Initial zoom badge should show 100%
    const initialBadge = await page.$eval(".zen-mermaid-container .zen-diagram-zoom-badge", (el) =>
      el.textContent?.trim(),
    );
    expect(initialBadge).toBe("100%");

    // Click Zoom In (+)
    await page.click('.zen-mermaid-container [data-action="zoom-in"]');
    const zoomedInBadge = await page.$eval(".zen-mermaid-container .zen-diagram-zoom-badge", (el) =>
      el.textContent?.trim(),
    );
    expect(zoomedInBadge).toBe("125%");

    // Verify canvas CSS transform has scale(1.25)
    const canvasTransform = await page.$eval(".zen-mermaid-container .zen-diagram-canvas", (el) =>
      el.getAttribute("style"),
    );
    expect(canvasTransform).toContain("scale(1.25)");

    // Click Reset (⟲)
    await page.click('.zen-mermaid-container [data-action="reset"]');
    const resetBadge = await page.$eval(".zen-mermaid-container .zen-diagram-zoom-badge", (el) =>
      el.textContent?.trim(),
    );
    expect(resetBadge).toBe("100%");

    // Click Fullscreen Lightbox (⛶)
    await page.click('.zen-mermaid-container [data-action="fullscreen"]');
    await page.waitForSelector("#zen-diagram-lightbox", { visible: true, timeout: 5000 });

    const lightboxVisible = await page.$eval(
      "#zen-diagram-lightbox",
      (el) => getComputedStyle(el).display,
    );
    expect(lightboxVisible).toBe("flex");

    // Verify lightbox canvas has diagram content
    const lightboxSvg = await page.$("#zen-lightbox-canvas");
    expect(lightboxSvg).not.toBeNull();

    // Press Escape to dismiss lightbox
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.getElementById("zen-diagram-lightbox")?.style.display === "none",
    );
  });

  it("displays multiple workspace documents in Left File Explorer", async () => {
    await page.waitForSelector(".zen-file-card", { timeout: 10000 });
    const fileCards = await page.$$(".zen-file-card");
    expect(fileCards.length).toBeGreaterThanOrEqual(2);

    const fileCount = await page.$eval("#zen-files-count", (el) => el.textContent);
    expect(parseInt(fileCount || "0", 10)).toBeGreaterThanOrEqual(2);
  });

  it("interactively selects question option cards and updates pending queue count", async () => {
    await page.waitForSelector(".zen-option-card", { timeout: 10000 });
    const optionCards = await page.$$(".zen-option-card");
    expect(optionCards.length).toBe(3);

    // Click on the second option: SQLite Embedded
    await optionCards[1].click();

    // Wait for pending count to update to 1
    await page.waitForFunction(
      () => {
        const countEl = document.getElementById("zen-pending-count");
        return countEl && countEl.textContent === "1";
      },
      { timeout: 10000 },
    );

    const pendingCount = await page.$eval("#zen-pending-count", (el) => el.textContent);
    expect(pendingCount).toBe("1");

    const queueCardText = await page.$eval(".zen-queue-card-text", (el) => el.textContent);
    expect(queueCardText).toContain("SQLite Embedded");
  });

  it("adds general note in composer and submits all queued prompts to agent", async () => {
    // Add note in composer
    await page.type("#zen-composer-input", "Please proceed with SQLite implementation.");
    await page.keyboard.press("Enter");

    // Pending count should be 2 (1 question answer + 1 note)
    await page.waitForFunction(
      () => {
        const countEl = document.getElementById("zen-pending-count");
        return countEl && countEl.textContent === "2";
      },
      { timeout: 10000 },
    );

    // Click Send to Agent button
    await page.click("#zen-send-btn");

    // Pending count should reset to 0
    await page.waitForFunction(
      () => {
        const countEl = document.getElementById("zen-pending-count");
        return countEl && countEl.textContent === "0";
      },
      { timeout: 10000 },
    );

    // Verify server session store recorded submitted items in promptHistory
    const session = store.getSession(testKey);
    expect(session).not.toBeNull();
    expect(session?.promptHistory.length).toBe(2);
    expect(session?.promptHistory[0].status).toBe("submitted");
  });

  it("displays resolved items with jump-to-modification pointers and highlights target lines", async () => {
    // Simulate agent applying modification and replying to submitted prompt
    const session = store.getSession(testKey);
    if (session) {
      store.addChatMessage(testKey, "agent" as any, "Adopted SQLite embedded database on line 39.");
    }

    // Switch to Resolved Tab in browser
    await page.click("#zen-tab-resolved");

    // Wait for resolved count to update to > 0
    await page.waitForFunction(
      () => {
        const countEl = document.getElementById("zen-resolved-count");
        return countEl && parseInt(countEl.textContent || "0", 10) > 0;
      },
      { timeout: 10000 },
    );

    const resolvedCount = await page.$eval("#zen-resolved-count", (el) => el.textContent);
    expect(parseInt(resolvedCount || "0", 10)).toBeGreaterThanOrEqual(1);

    // Verify resolved card and jump button exist
    await page.waitForSelector(".zen-resolved-card .zen-jump-btn", { timeout: 10000 });
    const jumpBtn = await page.$(".zen-resolved-card .zen-jump-btn");
    expect(jumpBtn).not.toBeNull();

    // Click Jump & Highlight button
    await jumpBtn?.click();

    // Verify target element receives the glowing pulse class
    await page.waitForFunction(
      () => {
        const highlighted = document.querySelector(".zen-resolved-highlight");
        return highlighted !== null;
      },
      { timeout: 10000 },
    );

    const highlightedEl = await page.$(".zen-resolved-highlight");
    expect(highlightedEl).not.toBeNull();
  });

  it("switches documents in workspace via Left File Explorer without page reload", async () => {
    // Find RFC card in left files list
    const rfcCard = await page.waitForSelector(`.zen-file-card[data-relpath*="rfc.md"]`, {
      timeout: 10000,
    });
    expect(rfcCard).not.toBeNull();

    // Click to switch document
    await rfcCard?.click();

    // Document view should update to Secondary RFC Document
    await page.waitForFunction(
      () => {
        const h1 = document.querySelector(".zen-document-container h1");
        return h1 && h1.textContent?.includes("Secondary RFC Document");
      },
      { timeout: 10000 },
    );

    const headingText = await page.$eval(".zen-document-container h1", (el) => el.textContent);
    expect(headingText).toContain("Secondary RFC Document");
  });

  it("hot reloads updated document in memory when modified on disk", async () => {
    // Append new section to secondFile (currently active in browser) on disk
    const updatedContent =
      fs.readFileSync(secondFile, "utf8") +
      "\n\n## Live Hot Reload Section\nHot reloading injected this content seamlessly.\n";
    fs.writeFileSync(secondFile, updatedContent, "utf8");

    // Wait for the browser to receive SSE reload and render the new section
    await page.waitForFunction(
      () => {
        const h2Elements = Array.from(document.querySelectorAll(".zen-document-container h2"));
        return h2Elements.some((el) => el.textContent?.includes("Live Hot Reload Section"));
      },
      { timeout: 10000 },
    );

    const hasNewSection = await page.evaluate(() => {
      const h2Elements = Array.from(document.querySelectorAll(".zen-document-container h2"));
      return h2Elements.some((el) => el.textContent?.includes("Live Hot Reload Section"));
    });
    expect(hasNewSection).toBe(true);
  });

  it("resolves disk modification across line shifts and highlights multi-element range on jump", async () => {
    // 1. Switch back to plan.md
    await page.evaluate(() => {
      const tab = document.getElementById("zen-tab-files");
      tab?.click();
      const card = document.querySelector('.zen-file-card[data-relpath*="plan.md"]') as HTMLElement;
      card?.click();
    });

    await page.waitForFunction(
      () => {
        const h1 = document.querySelector(".zen-document-container h1");
        return h1 && h1.textContent?.includes("Zen Architecture Plan");
      },
      { timeout: 10000 },
    );

    // 2. Submit annotation targeting Section 3 in plan.md
    const session = store.getSession(testKey);
    const targetOldLine = 20; // "## 3. Mathematical Foundations" at line 20 in original plan.md
    const promptId = `prompt-shift-${Date.now()}`;
    if (session) {
      session.promptHistory.push({
        id: promptId,
        tag: "annotation" as any,
        text: "Please add proof of token bounds to mathematical foundations",
        target: {
          type: "markdown-range" as any,
          startLine: targetOldLine,
          endLine: targetOldLine + 2,
        },
        createdAt: new Date().toISOString(),
        status: "submitted" as any,
      });
    }

    // 3. Update plan.md on disk with:
    // - 10 lines inserted in Section 1 (shifting Section 3 from line 20 to line 31)
    // - Multi-element addition in Section 3 (heading + paragraph + codeblock)
    const currentPlan = fs.readFileSync(testFile, "utf8");
    const insertedSection1 =
      "\nLine A inserted\nLine B inserted\nLine C inserted\nLine D inserted\nLine E inserted\nLine F inserted\nLine G inserted\nLine H inserted\nLine I inserted\nLine J inserted\n";
    const planWithShift = currentPlan.replace(
      "The agent and human collaborate seamlessly.",
      `The agent and human collaborate seamlessly.${insertedSection1}`,
    );
    const multiBlockAddition = `\n\n### Proof of Token Bounds\nHere is the rigorous proof of token compression bounds:\n\n\`\`\`typescript\nfunction computeBound(): number {\n  return 0.72;\n}\n\`\`\`\n`;
    const finalUpdatedPlan = planWithShift + multiBlockAddition;

    // Write to disk and record in store
    fs.writeFileSync(testFile, finalUpdatedPlan, "utf8");
    store.recordFileUpdate(testKey, finalUpdatedPlan);

    // 4. Wait for browser to hot-reload and render the new section
    await page.waitForFunction(
      () => {
        const h3Elements = Array.from(document.querySelectorAll(".zen-document-container h3"));
        return h3Elements.some((el) => el.textContent?.includes("Proof of Token Bounds"));
      },
      { timeout: 10000 },
    );

    // 5. Switch to Resolved tab
    await page.evaluate(() => {
      const tab = document.getElementById("zen-tab-resolved");
      tab?.click();
    });

    // Wait for the resolved card with our prompt to appear
    await page.waitForFunction(
      () => {
        const cards = Array.from(document.querySelectorAll<HTMLElement>(".zen-resolved-card"));
        return cards.some((c) => c.textContent?.includes("proof of token bounds"));
      },
      { timeout: 10000 },
    );

    // Verify resolved prompt was mapped accurately (shifted past line 30, not frontmatter!)
    const resolvedPrompt = session?.promptHistory.find((p) => p.id === promptId);
    expect(resolvedPrompt?.status).toBe("resolved");
    expect(resolvedPrompt?.resolution?.startLine).toBeGreaterThanOrEqual(30);

    // 6. Click Jump & Highlight button for this specific prompt
    const clickResult = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll<HTMLElement>(".zen-resolved-card"));
      const card = cards.find((c) => c.textContent?.includes("proof of token bounds"));
      const btn = card?.querySelector<HTMLButtonElement>(".zen-jump-btn");
      if (!btn) return false;
      btn.click();
      return true;
    });
    expect(clickResult).toBe(true);

    // 7. Verify multi-element highlight: elements in the target range receive the glowing pulse
    const highlightHandle = await page.waitForFunction(
      () => {
        const highlighted = Array.from(
          document.querySelectorAll<HTMLElement>(".zen-resolved-highlight"),
        );
        if (highlighted.length === 0) return false;
        return {
          count: highlighted.length,
          startLines: highlighted.map((el) =>
            parseInt(el.getAttribute("data-line-start") || "0", 10),
          ),
        };
      },
      { timeout: 10000 },
    );

    const result = (await highlightHandle.jsonValue()) as { count: number; startLines: number[] };
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(Math.max(...result.startLines)).toBeGreaterThanOrEqual(30);
  });

  it("interactively clicks Approve Plan button and marks session approved", async () => {
    // Switch back to plan.md via Documents tab
    await page.evaluate(() => {
      const tab = document.getElementById("zen-tab-files");
      tab?.click();
      const card = document.querySelector('.zen-file-card[data-relpath*="plan.md"]') as HTMLElement;
      card?.click();
    });

    // Wait for plan.md to be active
    await page.waitForFunction(
      () => {
        const h1 = document.querySelector(".zen-document-container h1");
        return h1 && h1.textContent?.includes("Zen Architecture Plan");
      },
      { timeout: 10000 },
    );

    // Click Approve Plan button
    await page.waitForSelector("#zen-approve-btn", { visible: true, timeout: 10000 });
    await page.evaluate(() => {
      const btn = document.getElementById("zen-approve-btn");
      btn?.click();
    });

    // Wait for button text to update to "✓ Plan Approved"
    await page.waitForFunction(
      () => {
        const btn = document.getElementById("zen-approve-btn");
        return btn && btn.textContent?.includes("Plan Approved");
      },
      { timeout: 10000 },
    );

    const btnText = await page.$eval("#zen-approve-btn", (el) => el.textContent);
    expect(btnText).toContain("Plan Approved");

    // Verify session store reflects approval
    const session = store.getSession(testKey);
    expect(session?.approved).toBe(true);
    expect(session?.approvedAt).toBeDefined();
  });
});

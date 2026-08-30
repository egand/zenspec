import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  SessionStore,
  sessionKey,
  computeLineDiff,
  scanWorkspaceDocuments,
} from "../src/session-store.js";
import { PromptItem, PollResponse } from "../src/types.js";

describe("SessionStore & Long-Polling Coordinator", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  it("generates deterministic 16-char sha256 session keys", () => {
    const key1 = sessionKey("/Users/egand/docs/plan.md");
    const key2 = sessionKey("/Users/egand/docs/plan.md");
    const key3 = sessionKey("/Users/egand/docs/other.md");

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1.length).toBe(16);
  });

  it("creates and retrieves session state", () => {
    const session = store.getOrCreateSession("/fake/path/architecture.md");
    expect(session.docType).toBe("markdown");
    expect(session.ended).toBe(false);
    expect(session.presence).toBe("waiting");

    const fetched = store.getSession(session.key);
    expect(fetched).toBeDefined();
    expect(fetched?.filePath).toBe("/fake/path/architecture.md");
  });

  it("queues prompts and flushes to active poll waiters immediately", async () => {
    const session = store.getOrCreateSession("/fake/path/test.md");

    let receivedResponse: PollResponse | null = null;

    // Register poll waiter
    store.registerPollWaiter(session.key, (res) => {
      receivedResponse = res;
    });

    const prompt: PromptItem = {
      id: "p1",
      tag: "annotation",
      text: "Change database to SQLite",
      target: {
        type: "markdown-range",
        startLine: 10,
        endLine: 12,
        selectedText: "PostgreSQL",
      },
      createdAt: new Date().toISOString(),
    };

    // Queue prompt
    store.queuePrompt(session.key, prompt);

    expect(receivedResponse).not.toBeNull();
    const res = receivedResponse as PollResponse | null;
    expect(res?.status).toBe("feedback");
    if (res && res.status === "feedback") {
      expect(res.prompts.length).toBe(1);
      expect(res.prompts[0].text).toBe("Change database to SQLite");
    }
  });

  it("emits ended event and resolves poll waiter when session is concluded", async () => {
    const session = store.getOrCreateSession("/fake/path/ended.md");

    let endedResponse: PollResponse | null = null;
    store.registerPollWaiter(session.key, (res) => {
      endedResponse = res;
    });

    store.endSession(session.key, "user");

    expect(endedResponse).not.toBeNull();
    const res = endedResponse as PollResponse | null;
    expect(res?.status).toBe("ended");
    if (res && res.status === "ended") {
      expect(res.endedBy).toBe("user");
    }
  });

  it("supersedes previous poll waiters when a new poll waiter registers", () => {
    const session = store.getOrCreateSession("/fake/path/supersede.md");

    let firstResponse: PollResponse | null = null;
    let secondResponse: PollResponse | null = null;

    // Register first waiter
    store.registerPollWaiter(session.key, (res) => {
      firstResponse = res;
    });

    // Register second waiter (should supersede first)
    store.registerPollWaiter(session.key, (res) => {
      secondResponse = res;
    });

    expect(firstResponse).not.toBeNull();
    expect((firstResponse as any)?.status).toBe("superseded");
    expect(secondResponse).toBeNull();
  });

  it("removes registered poll waiter correctly", () => {
    const session = store.getOrCreateSession("/fake/path/removal.md");
    let called = false;
    const waiter = () => {
      called = true;
    };

    store.registerPollWaiter(session.key, waiter);
    store.removePollWaiter(session.key, waiter);

    store.queuePrompt(session.key, {
      id: "p-rm",
      tag: "chat",
      text: "Unseen",
      createdAt: new Date().toISOString(),
    });

    expect(called).toBe(false);
  });

  it("manages agent chat history and presence transitions", () => {
    const session = store.getOrCreateSession(`/fake/path/chat-${Date.now()}.md`);

    store.setPresence(session.key, "listening");
    expect(session.presence).toBe("listening");

    const msg = store.addChatMessage(session.key, "agent", "Updated lines 14-16 with feedback.");
    expect(msg.sender).toBe("agent");
    expect(session.chatHistory.length).toBe(1);
  });

  describe("computeLineDiff", () => {
    it.each([
      {
        name: "identical text",
        oldText: "Line 1\nLine 2",
        newText: "Line 1\nLine 2",
        expectedDiffs: 0,
      },
      {
        name: "empty old text",
        oldText: "",
        newText: "Line 1\nLine 2",
        expectedDiffs: 0,
      },
      {
        name: "middle line modification",
        oldText: "Line 1\nLine 2\nLine 3",
        newText: "Line 1\nLine 2 modified\nLine 3",
        expectedDiffs: 1,
      },
      {
        name: "trailing addition",
        oldText: "Line 1\nLine 2",
        newText: "Line 1\nLine 2\nLine 3 added",
        expectedDiffs: 1,
      },
    ])("computes diff for $name", ({ oldText, newText, expectedDiffs }) => {
      const diffs = computeLineDiff(oldText, newText);
      expect(diffs.length).toBe(expectedDiffs);
    });
  });

  it("scans workspace directory and filters Markdown and HTML files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zen-scan-test-"));
    try {
      fs.writeFileSync(path.join(tempDir, "README.md"), "# Root");
      fs.writeFileSync(path.join(tempDir, "index.html"), "<h1>Home</h1>");
      fs.writeFileSync(path.join(tempDir, "ignore.txt"), "Ignore me");

      const subDir = path.join(tempDir, "sub");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, "spec.markdown"), "## Spec");

      const nodeModules = path.join(tempDir, "node_modules");
      fs.mkdirSync(nodeModules);
      fs.writeFileSync(path.join(nodeModules, "pkg.md"), "Should be skipped");

      const docs = scanWorkspaceDocuments(tempDir);
      expect(docs.length).toBe(3);
      const relPaths = docs.map((d) => d.relPath);
      expect(relPaths).toContain("README.md");
      expect(relPaths).toContain("index.html");
      expect(relPaths).toContain(path.join("sub", "spec.markdown"));
      expect(relPaths).not.toContain("ignore.txt");
      expect(relPaths).not.toContain(path.join("node_modules", "pkg.md"));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("tracks and broadcasts agent telemetry progress updates", () => {
    const session = store.getOrCreateSession(`/fake/path/progress-${Date.now()}.md`);

    store.setProgress(session.key, {
      id: "p-1",
      timestamp: new Date().toISOString(),
      step: "Compiling TypeScript",
      status: "running",
      details: "Running esbuild bundle",
    });

    expect(session.activeProgress?.step).toBe("Compiling TypeScript");
    expect(session.activeProgress?.status).toBe("running");
  });
});

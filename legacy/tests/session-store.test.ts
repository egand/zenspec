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
import {
  PromptItem,
  PollResponse,
  DocType,
  AgentPresence,
  ActorRole,
  PollStatus,
  PromptTag,
  TargetType,
  ProgressStatus,
} from "../src/types.js";

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
    expect(session.docType).toBe(DocType.Markdown);
    expect(session.ended).toBe(false);
    expect(session.presence).toBe(AgentPresence.Waiting);

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
      tag: PromptTag.Annotation,
      text: "Change database to SQLite",
      target: {
        type: TargetType.MarkdownRange,
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
    expect(res?.status).toBe(PollStatus.Feedback);
    if (res && res.status === PollStatus.Feedback) {
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

    store.endSession(session.key, ActorRole.User);

    expect(endedResponse).not.toBeNull();
    const res = endedResponse as PollResponse | null;
    expect(res?.status).toBe(PollStatus.Ended);
    if (res && res.status === PollStatus.Ended) {
      expect(res.endedBy).toBe(ActorRole.User);
    }
  });

  it("approves session and resolves poll waiter with status: approved", async () => {
    const session = store.getOrCreateSession(`/fake/path/approve-test-${Date.now()}.md`);
    expect(session.approved).toBe(false);

    let pollResult: PollResponse | null = null;
    store.registerPollWaiter(session.key, (res) => {
      pollResult = res;
    });

    store.approveSession(session.key, "Looks good to implement");

    expect(session.approved).toBe(true);
    expect(session.approvedAt).toBeDefined();
    expect(pollResult).not.toBeNull();
    expect((pollResult as any)?.status).toBe(PollStatus.Approved);
    expect((pollResult as any)?.approved).toBe(true);
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
    expect((firstResponse as any)?.status).toBe(PollStatus.Superseded);
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
      tag: PromptTag.Chat,
      text: "Unseen",
      createdAt: new Date().toISOString(),
    });

    expect(called).toBe(false);
  });

  it("manages agent chat history and presence transitions", () => {
    const session = store.getOrCreateSession(`/fake/path/chat-${Date.now()}.md`);

    store.setPresence(session.key, AgentPresence.Listening);
    expect(session.presence).toBe(AgentPresence.Listening);

    const msg = store.addChatMessage(
      session.key,
      ActorRole.Agent,
      "Updated lines 14-16 with feedback.",
    );
    expect(msg.sender).toBe(ActorRole.Agent);
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
      status: ProgressStatus.Running,
      details: "Running esbuild bundle",
    });

    expect(session.activeProgress?.step).toBe("Compiling TypeScript");
    expect(session.activeProgress?.status).toBe(ProgressStatus.Running);
  });

  describe("resolvePromptsWithDiff & Coordinate Drift Tracking", () => {
    it("maps prompt target across preceding line insertions accurately", () => {
      const session = store.getOrCreateSession(`/fake/path/drift-${Date.now()}.md`);

      // Initial document: 60 lines
      const oldLines: string[] = [];
      for (let i = 1; i <= 60; i++) {
        oldLines.push(`Original Line ${i}`);
      }
      session.currentContent = oldLines.join("\n");

      // User submits prompt targeting old Line 50
      const prompt: PromptItem = {
        id: "prompt-section-50",
        tag: PromptTag.Annotation,
        text: "Please expand section at line 50",
        target: {
          type: TargetType.MarkdownRange,
          startLine: 50,
          endLine: 52,
        },
        createdAt: new Date().toISOString(),
        status: "submitted",
      };
      session.promptHistory = [prompt];

      // Agent edits document:
      // 1. Inserts 20 lines at line 10 (diff A: lines 10 to 30)
      // 2. Modifies section at old line 50 (which is now line 70 in new file!)
      const newLines: string[] = [];
      for (let i = 1; i <= 9; i++) newLines.push(`Original Line ${i}`);
      for (let i = 1; i <= 20; i++) newLines.push(`Inserted Line ${i}`); // Lines 10-29
      for (let i = 10; i <= 49; i++) newLines.push(`Original Line ${i}`); // Lines 30-69
      newLines.push("Expanded Section Line 50"); // Line 70
      newLines.push("Expanded Section Line 51"); // Line 71
      newLines.push("Expanded Section Line 52"); // Line 72
      for (let i = 53; i <= 60; i++) newLines.push(`Original Line ${i}`); // Lines 73-80

      const diffs = store.recordFileUpdate(session.key, newLines.join("\n"));
      expect(diffs.length).toBeGreaterThanOrEqual(2);

      // Verify prompt resolution:
      // Must link to lines ~70-72 in the new file, NOT the insertion at line 10!
      const resolved = session.promptHistory.find((p) => p.id === "prompt-section-50");
      expect(resolved?.status).toBe("resolved");
      expect(resolved?.resolution).toBeDefined();
      expect(resolved?.resolution?.startLine).toBeGreaterThanOrEqual(68);
      expect(resolved?.resolution?.startLine).toBeLessThanOrEqual(72);
      expect(resolved?.resolution?.diffSummary).toContain("Expanded Section");
    });

    it("prioritizes substantive content diff over frontmatter edit for chat prompts without target lines", () => {
      const session = store.getOrCreateSession(`/fake/path/frontmatter-${Date.now()}.md`);

      const oldContent = `---
title: Initial Title
version: 1.0.0
---

# Section 1
Content here.

# Section 2
Needs substantial architecture update.`;

      session.currentContent = oldContent;

      const chatPrompt: PromptItem = {
        id: "prompt-chat-global",
        tag: PromptTag.Chat,
        text: "Add details about the security architecture",
        createdAt: new Date().toISOString(),
        status: "submitted",
      };
      session.promptHistory = [chatPrompt];

      // Agent edits frontmatter (line 3 version bump) AND adds 15 lines of security architecture in Section 2
      const newContent = `---
title: Initial Title
version: 1.0.1
---

# Section 1
Content here.

# Section 2
Needs substantial architecture update.

### Security Architecture
- Implement OAuth2 Bearer token authentication
- Require PKCE for public clients
- Sign all state cookies with HMAC-SHA256
- Enforce Content-Security-Policy headers`;

      store.recordFileUpdate(session.key, newContent);

      const resolved = session.promptHistory.find((p) => p.id === "prompt-chat-global");
      expect(resolved?.status).toBe("resolved");
      expect(resolved?.resolution).toBeDefined();

      // Must link to the substantive body section (lines > 10), NOT the line 3 version bump!
      expect(resolved?.resolution?.startLine).toBeGreaterThan(8);
      expect(resolved?.resolution?.diffSummary).toContain("Security Architecture");
    });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore, sessionKey } from "../src/session-store.js";
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

  it("manages agent chat history and presence transitions", () => {
    const session = store.getOrCreateSession(`/fake/path/chat-${Date.now()}.md`);

    store.setPresence(session.key, "listening");
    expect(session.presence).toBe("listening");

    const msg = store.addChatMessage(session.key, "agent", "Updated lines 14-16 with feedback.");
    expect(msg.sender).toBe("agent");
    expect(session.chatHistory.length).toBe(1);
  });
});

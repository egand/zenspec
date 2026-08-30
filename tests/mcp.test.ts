import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../src/mcp.js";
import { SessionStore } from "../src/session-store.js";

describe("Zen Native MCP Server End-to-End Tools", () => {
  let store: SessionStore;
  let client: Client;
  let testFile: string;

  beforeEach(async () => {
    store = new SessionStore();
    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-mcp-client", version: "1.0.0" }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    testFile = path.join(os.tmpdir(), `zen-mcp-${Date.now()}.md`);
    fs.writeFileSync(
      testFile,
      "# MCP Architecture\n\n> [!QUESTION] Pick engine\n> - [x] Node\n> - [ ] Go\n",
      "utf8",
    );
  });

  afterEach(async () => {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  });

  it("lists all 7 available zen tools with descriptions and schemas", async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);

    expect(names).toContain("zen_open_review");
    expect(names).toContain("zen_poll_feedback");
    expect(names).toContain("zen_reply");
    expect(names).toContain("zen_progress");
    expect(names).toContain("zen_end_session");
    expect(names).toContain("zen_get_status");
    expect(names).toContain("zen_export_adr");
    expect(names.length).toBe(7);
  });

  it("executes zen_get_status tool", async () => {
    const result: any = await client.callTool({
      name: "zen_get_status",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe("text");
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBeDefined();
  });

  it("executes zen_open_review and registers session in store", async () => {
    const result: any = await client.callTool({
      name: "zen_open_review",
      arguments: { filePath: testFile, noOpen: true },
    });

    expect(result.content).toBeDefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.key).toBeDefined();
    expect(data.url).toContain(data.key);

    const session = store.getSession(data.key);
    expect(session).toBeDefined();
    expect(session?.canonicalPath).toBe(fs.realpathSync(testFile));
  });

  it("executes zen_reply and delivers agent chat message", async () => {
    const result: any = await client.callTool({
      name: "zen_reply",
      arguments: { filePath: testFile, message: "Review update ready" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);

    const session = store.getSessionByFile(testFile);
    expect(session?.chatHistory.some((c) => c.text === "Review update ready")).toBe(true);
  });

  it("executes zen_progress and sets agent telemetry", async () => {
    const result: any = await client.callTool({
      name: "zen_progress",
      arguments: { filePath: testFile, step: "Building bundle", status: "running" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);

    const session = store.getSessionByFile(testFile);
    expect(session?.activeProgress?.step).toBe("Building bundle");
    expect(session?.presence).toBe("working");
  });

  it("executes zen_poll_feedback when prompts are queued", async () => {
    const session = store.getOrCreateSession(testFile);
    store.queuePrompt(session.key, {
      id: "p-test",
      tag: "annotation",
      text: "Approve database schema",
      createdAt: new Date().toISOString(),
    });

    const result: any = await client.callTool({
      name: "zen_poll_feedback",
      arguments: { filePath: testFile },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe("feedback");
    expect(data.prompts.length).toBe(1);
    expect(data.prompts[0].text).toBe("Approve database schema");
  });

  it("executes zen_export_adr and writes decision record to disk", async () => {
    const adrOut = path.join(os.tmpdir(), `zen-adr-mcp-${Date.now()}.md`);

    try {
      const result: any = await client.callTool({
        name: "zen_export_adr",
        arguments: { filePath: testFile, outPath: adrOut },
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.adrFile).toBe(adrOut);
      expect(fs.existsSync(adrOut)).toBe(true);
      const content = fs.readFileSync(adrOut, "utf8");
      expect(content).toContain("# ADR-0001: MCP Architecture");
      expect(content).toContain("Node");
    } finally {
      if (fs.existsSync(adrOut)) fs.unlinkSync(adrOut);
    }
  });

  it("executes zen_end_session and marks session as concluded", async () => {
    const result: any = await client.callTool({
      name: "zen_end_session",
      arguments: { filePath: testFile },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);

    const session = store.getSessionByFile(testFile);
    expect(session?.ended).toBe(true);
  });

  it("throws error for non-existent file on tools requiring valid path", async () => {
    await expect(
      client.callTool({
        name: "zen_export_adr",
        arguments: { filePath: "/non/existent/path.md" },
      }),
    ).rejects.toThrow();
  });
});

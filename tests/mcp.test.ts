import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer } from "../src/mcp.js";
import { SessionStore } from "../src/session-store.js";
import { McpToolName, PollStatus, AgentPresence, PromptTag, ProgressStatus } from "../src/types.js";

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

  it("lists all 8 available zen tools with descriptions and schemas", async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name);

    expect(names).toContain(McpToolName.OpenReview);
    expect(names).toContain(McpToolName.PollFeedback);
    expect(names).toContain(McpToolName.ApprovePlan);
    expect(names).toContain(McpToolName.Reply);
    expect(names).toContain(McpToolName.Progress);
    expect(names).toContain(McpToolName.EndSession);
    expect(names).toContain(McpToolName.GetStatus);
    expect(names).toContain(McpToolName.ExportAdr);
    expect(names.length).toBe(8);
  });

  it("executes zen_get_status tool", async () => {
    const result: any = await client.callTool({
      name: McpToolName.GetStatus,
      arguments: {},
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe("text");
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBeDefined();
  });

  it("executes zen_open_review with mandatory polling and returns queued feedback", async () => {
    const canonical = fs.realpathSync(testFile);
    const session = store.getOrCreateSession(canonical);
    store.queuePrompt(session.key, {
      id: "p1",
      tag: PromptTag.Annotation,
      text: "Clarify system diagram",
      createdAt: new Date().toISOString(),
    });

    const result: any = await client.callTool({
      name: McpToolName.OpenReview,
      arguments: { filePath: testFile, noOpen: true },
    });

    expect(result.content).toBeDefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe(PollStatus.Feedback);
    expect(data.prompts.length).toBe(1);
    expect(data.prompts[0].text).toBe("Clarify system diagram");
  });

  it("executes zen_open_review and resolves when plan is already approved", async () => {
    const canonical = fs.realpathSync(testFile);
    const session = store.getOrCreateSession(canonical);
    store.approveSession(session.key, "Approved already");

    const result: any = await client.callTool({
      name: McpToolName.OpenReview,
      arguments: { filePath: testFile, noOpen: true },
    });

    expect(result.content).toBeDefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe(PollStatus.Approved);
    expect(data.approved).toBe(true);
  });

  it("executes zen_reply and delivers agent chat message", async () => {
    const result: any = await client.callTool({
      name: McpToolName.Reply,
      arguments: { filePath: testFile, message: "Review update ready" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);

    const session = store.getSessionByFile(testFile);
    expect(session?.chatHistory.some((c) => c.text === "Review update ready")).toBe(true);
  });

  it("executes zen_progress and sets agent telemetry", async () => {
    const result: any = await client.callTool({
      name: McpToolName.Progress,
      arguments: { filePath: testFile, step: "Building bundle", status: ProgressStatus.Running },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);

    const session = store.getSessionByFile(testFile);
    expect(session?.activeProgress?.step).toBe("Building bundle");
    expect(session?.presence).toBe(AgentPresence.Working);
  });

  it("executes zen_poll_feedback when prompts are queued", async () => {
    const session = store.getOrCreateSession(testFile);
    store.queuePrompt(session.key, {
      id: "p-test",
      tag: PromptTag.Annotation,
      text: "Approve database schema",
      createdAt: new Date().toISOString(),
    });

    const result: any = await client.callTool({
      name: McpToolName.PollFeedback,
      arguments: { filePath: testFile },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe(PollStatus.Feedback);
    expect(data.prompts.length).toBe(1);
    expect(data.prompts[0].text).toBe("Approve database schema");
  });

  it("executes zen_export_adr and writes decision record to disk", async () => {
    const adrOut = path.join(os.tmpdir(), `zen-adr-mcp-${Date.now()}.md`);

    try {
      const result: any = await client.callTool({
        name: McpToolName.ExportAdr,
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
      name: McpToolName.EndSession,
      arguments: { filePath: testFile },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);

    const session = store.getSessionByFile(testFile);
    expect(session?.ended).toBe(true);
  });

  it("executes zen_approve_plan and sets session approval state", async () => {
    const result: any = await client.callTool({
      name: McpToolName.ApprovePlan,
      arguments: { filePath: testFile, notes: "Approved for execution" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.approved).toBe(true);

    const session = store.getSessionByFile(testFile);
    expect(session?.approved).toBe(true);
    expect(session?.approvedAt).toBeDefined();
  });

  it("throws error for non-existent file on tools requiring valid path", async () => {
    await expect(
      client.callTool({
        name: McpToolName.ExportAdr,
        arguments: { filePath: "/non/existent/path.md" },
      }),
    ).rejects.toThrow();
  });
});

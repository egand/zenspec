import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ZenServer } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";
import {
  DocType,
  PromptTag,
  TargetType,
  PollStatus,
  ProgressStatus,
  ActorRole,
} from "../src/types.js";

describe("ZenServer HTTP & API Endpoints", () => {
  let server: ZenServer;
  let testFile: string;
  let testKey: string;
  let port: number;

  beforeAll(async () => {
    // Create temporary markdown test file
    testFile = path.join(os.tmpdir(), `zen-test-${Date.now()}.md`);
    fs.writeFileSync(testFile, "# Test Spec\n\nParagraph for testing HTTP routes.\n", "utf8");

    const store = new SessionStore();
    const session = store.getOrCreateSession(testFile);
    testKey = session.key;

    server = new ZenServer({ port: 0, store });
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.stop();
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  });

  it("responds to /health with ok status and version", async () => {
    const data: any = await fetchJson(`http://127.0.0.1:${port}/health`);
    expect(data.ok).toBe(true);
    expect(data.app).toBe("zenspec");
    expect(data.version).toBe("0.1.0");
  });

  it("serves document content and rendered HTML via /api/:key/document", async () => {
    const data: any = await fetchJson(`http://127.0.0.1:${port}/api/${testKey}/document`);
    expect(data.key).toBe(testKey);
    expect(data.docType).toBe(DocType.Markdown);
    expect(data.renderedHtml).toContain("<h1");
    expect(data.renderedHtml).toContain("Test Spec");
  });

  it("accepts prompt submission via POST /api/:key/prompts and resolves poll", async () => {
    // Start async long poll
    const pollPromise = fetchJson(`http://127.0.0.1:${port}/api/poll?key=${testKey}`);

    // Give poll 50ms to register
    await new Promise((r) => setTimeout(r, 50));

    // Submit prompt
    const postRes: any = await postJson(`http://127.0.0.1:${port}/api/${testKey}/prompts`, {
      prompts: [
        {
          tag: PromptTag.Annotation,
          text: "Please add validation logic.",
          target: {
            type: TargetType.MarkdownRange,
            startLine: 3,
            endLine: 3,
          },
        },
      ],
    });

    expect(postRes.success).toBe(true);
    expect(postRes.count).toBe(1);

    // Verify poll returned the feedback
    const pollData: any = await pollPromise;
    expect(pollData.status).toBe(PollStatus.Feedback);
    expect(pollData.prompts.length).toBe(1);
    expect(pollData.prompts[0].text).toBe("Please add validation logic.");
  });

  it("handles agent replies via POST /api/:key/reply", async () => {
    const postRes: any = await postJson(`http://127.0.0.1:${port}/api/${testKey}/reply`, {
      message: "Added input validation as requested.",
    });
    expect(postRes.success).toBe(true);

    const doc: any = await fetchJson(`http://127.0.0.1:${port}/api/${testKey}/document`);
    expect(doc.chatHistory.some((m: any) => m.text.includes("Added input validation"))).toBe(true);
  });

  it("accepts live telemetry progress updates via POST /api/:key/progress", async () => {
    const postRes: any = await postJson(`http://127.0.0.1:${port}/api/${testKey}/progress`, {
      step: "Refactoring database migrations",
      status: ProgressStatus.Running,
    });
    expect(postRes.success).toBe(true);

    const doc: any = await fetchJson(`http://127.0.0.1:${port}/api/${testKey}/document`);
    expect(doc.activeProgress?.step).toBe("Refactoring database migrations");
  });

  it("serves workspace documents via GET /api/:key/workspace and GET /api/workspace", async () => {
    const dataKey: any = await fetchJson(`http://127.0.0.1:${port}/api/${testKey}/workspace`);
    expect(dataKey.workspaceRoot).toBeDefined();
    expect(Array.isArray(dataKey.files)).toBe(true);

    const dataGlobal: any = await fetchJson(`http://127.0.0.1:${port}/api/workspace`);
    expect(dataGlobal.workspaceRoot).toBeDefined();
    expect(Array.isArray(dataGlobal.files)).toBe(true);
  });

  it("generates Architecture Decision Records via GET /api/:key/adr", async () => {
    const data: any = await fetchJson(`http://127.0.0.1:${port}/api/${testKey}/adr`);
    expect(data.adr).toContain("# ADR-0001: Test Spec");
    expect(data.adr).toContain("## Considered Options & Decisions");
  });

  it("approves plan via POST /api/:key/approve", async () => {
    const approveRes: any = await postJson(`http://127.0.0.1:${port}/api/${testKey}/approve`, {
      notes: "Reviewed and approved",
    });
    expect(approveRes.success).toBe(true);
    expect(approveRes.approved).toBe(true);

    const doc: any = await fetchJson(`http://127.0.0.1:${port}/api/${testKey}/document`);
    expect(doc.approved).toBe(true);
    expect(doc.approvedAt).toBeDefined();
  });

  it("marks session ended via POST /api/:key/end", async () => {
    const endRes: any = await postJson(`http://127.0.0.1:${port}/api/${testKey}/end`, {
      endedBy: ActorRole.Agent,
    });
    expect(endRes.success).toBe(true);

    const pollRes: any = await fetchJson(`http://127.0.0.1:${port}/api/poll?key=${testKey}`);
    expect(pollRes.status).toBe(PollStatus.Ended);
    expect(pollRes.endedBy).toBe(ActorRole.Agent);
  });

  it("returns 404 for non-existent session key on document and ADR routes", async () => {
    const docRes = await fetchStatus(`http://127.0.0.1:${port}/api/invalidkey99/document`);
    expect(docRes).toBe(404);

    const adrRes = await fetchStatus(`http://127.0.0.1:${port}/api/invalidkey99/adr`);
    expect(adrRes).toBe(404);
  });

  it("returns 400 for /api/poll when key query parameter is missing", async () => {
    const status = await fetchStatus(`http://127.0.0.1:${port}/api/poll`);
    expect(status).toBe(400);
  });

  it("serves HTML review canvas at /session/:key", async () => {
    const res = await fetchRaw(`http://127.0.0.1:${port}/session/${testKey}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<!doctype html>");
    expect(res.body).toContain("ZenSpec Reviewer");
  });
});

async function fetchStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        resolve(res.statusCode || 500);
      })
      .on("error", reject);
  });
}

async function fetchRaw(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode || 500, body }));
      })
      .on("error", reject);
  });
}

async function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        });
      })
      .on("error", reject);
  });
}

async function postJson(url: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/**
 * Native Model Context Protocol (MCP) Server for Zen AXI
 * Allows LLM coding harnesses (Cursor, Claude Desktop, Antigravity, Windsurf)
 * to interact with Zen AXI via native tool calling.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import open from "open";
import { SessionStore, sessionKey } from "./session-store.js";
import { generateADRDocument, resolveDefaultAdrPath } from "./adr.js";
import { ZenServer } from "./server.js";

const DEFAULT_PORT = 4388;
const DEFAULT_HOST = "127.0.0.1";

async function isServerRunning(port = DEFAULT_PORT, host = DEFAULT_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureServerRunning(port = DEFAULT_PORT, host = DEFAULT_HOST): Promise<void> {
  if (await isServerRunning(port, host)) return;
  const server = new ZenServer({ port, host });
  await server.start();
}

export function createMcpServer(store = new SessionStore()): Server {
  const server = new Server(
    {
      name: "zen-axi",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "zen_open_review",

          description:
            "Start the Zen AXI review daemon and open a Markdown or HTML document in the browser for interactive review.",
          inputSchema: {
            type: "object",
            properties: {
              filePath: {
                type: "string",
                description: "Path to the Markdown or HTML document to review.",
              },
              noOpen: {
                type: "boolean",
                description: "If true, registers session without opening system browser.",
              },
            },
            required: ["filePath"],
          },
        },
        {
          name: "zen_poll_feedback",
          description:
            "Long-poll until human reviewer submits annotations, suggestions, or question selections on the document.",
          inputSchema: {
            type: "object",
            properties: {
              filePath: {
                type: "string",
                description: "Path to the Markdown or HTML document being reviewed.",
              },
              agentReply: {
                type: "string",
                description: "Optional message or progress note to send before polling.",
              },
            },
            required: ["filePath"],
          },
        },
        {
          name: "zen_reply",
          description:
            "Send an agent progress note or chat message to the reviewer in the browser.",
          inputSchema: {
            type: "object",
            properties: {
              filePath: {
                type: "string",
                description: "Path to the reviewed document.",
              },
              message: {
                type: "string",
                description: "Message text to display in the reviewer conversation panel.",
              },
            },
            required: ["filePath", "message"],
          },
        },
        {
          name: "zen_progress",
          description:
            "Stream live agent execution telemetry (step status, running tests, applying patches) to reviewer topbar.",
          inputSchema: {
            type: "object",
            properties: {
              filePath: {
                type: "string",
                description: "Path to the reviewed document.",
              },
              step: {
                type: "string",
                description: "Short description of the active step being executed.",
              },
              status: {
                type: "string",
                enum: ["running", "done", "error"],
                description: "Status of the step.",
              },
              details: {
                type: "string",
                description: "Optional detailed log or output.",
              },
            },
            required: ["filePath", "step"],
          },
        },
        {
          name: "zen_end_session",
          description: "Conclude an active review session as the agent.",
          inputSchema: {
            type: "object",
            properties: {
              filePath: {
                type: "string",
                description: "Path to the document whose review session should be ended.",
              },
            },
            required: ["filePath"],
          },
        },
        {
          name: "zen_get_status",
          description: "List all active Zen AXI review sessions and queued feedback counts.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "zen_export_adr",
          description:
            "Export and materialize answered interactive questions into a standard Architecture Decision Record (ADR).",
          inputSchema: {
            type: "object",
            properties: {
              filePath: {
                type: "string",
                description: "Path to the reviewed Markdown document.",
              },
              outPath: {
                type: "string",
                description: "Optional output path (defaults to docs/adr/0001-...md).",
              },
            },
            required: ["filePath"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "zen_open_review") {
      const filePath = String(args?.filePath || "");
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      const canonical = fs.realpathSync(filePath);
      const session = store.getOrCreateSession(canonical);
      await ensureServerRunning();

      const sessionUrl = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/session/${session.key}`;
      if (!args?.noOpen) {
        await open(sessionUrl).catch(() => {});
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                key: session.key,
                sessionKey: session.key,
                url: sessionUrl,
                file: canonical,
                docType: session.docType,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "zen_poll_feedback") {
      const filePath = String(args?.filePath || "");
      const canonical = fs.existsSync(filePath)
        ? fs.realpathSync(filePath)
        : path.resolve(filePath);
      const key = sessionKey(canonical);
      const session = store.getOrCreateSession(canonical);

      if (args?.agentReply) {
        store.addChatMessage(key, "agent", String(args.agentReply));
      }

      if (session.queuedPrompts.length > 0) {
        const prompts = store.takeQueuedPrompts(key);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "feedback",
                file: session.filePath,
                prompts,
                sessionEnded: session.ended,
                endedBy: session.endedBy,
              }),
            },
          ],
        };
      }

      if (session.ended) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "ended",
                file: session.filePath,
                endedBy: session.endedBy,
                message: `Session was concluded by ${session.endedBy || "user"}.`,
              }),
            },
          ],
        };
      }

      const result = await new Promise((resolve) => {
        store.registerPollWaiter(key, (res) => resolve(res));
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === "zen_reply") {
      const filePath = String(args?.filePath || "");
      const message = String(args?.message || "");
      const canonical = fs.existsSync(filePath)
        ? fs.realpathSync(filePath)
        : path.resolve(filePath);
      const session = store.getOrCreateSession(canonical);
      const msg = store.addChatMessage(session.key, "agent", message);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, messageId: msg.id }),
          },
        ],
      };
    }

    if (name === "zen_progress") {
      const filePath = String(args?.filePath || "");
      const step = String(args?.step || "");
      const status = (args?.status as any) || "running";
      const details = args?.details ? String(args.details) : undefined;
      const canonical = fs.existsSync(filePath)
        ? fs.realpathSync(filePath)
        : path.resolve(filePath);
      const session = store.getOrCreateSession(canonical);

      const update = {
        id: `prog-${Date.now()}`,
        timestamp: new Date().toISOString(),
        step,
        status,
        details,
      };

      store.setProgress(session.key, update);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, progress: update }),
          },
        ],
      };
    }

    if (name === "zen_end_session") {
      const filePath = String(args?.filePath || "");
      const canonical = fs.existsSync(filePath)
        ? fs.realpathSync(filePath)
        : path.resolve(filePath);
      const session = store.getOrCreateSession(canonical);
      store.endSession(session.key, "agent");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, endedBy: "agent" }),
          },
        ],
      };
    }

    if (name === "zen_get_status") {
      const sessions = store.getAllSessions();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: sessions.length, sessions }, null, 2),
          },
        ],
      };
    }

    if (name === "zen_export_adr") {
      const filePath = String(args?.filePath || "");
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      const canonical = fs.realpathSync(filePath);
      const session = store.getOrCreateSession(canonical);
      const raw = fs.readFileSync(canonical, "utf8");

      const adrContent = generateADRDocument({ session, docContent: raw });
      const customOut = args?.outPath ? String(args.outPath) : undefined;
      const outPath = resolveDefaultAdrPath(canonical, customOut);

      fs.writeFileSync(outPath, adrContent, "utf8");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, adrFile: outPath }),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

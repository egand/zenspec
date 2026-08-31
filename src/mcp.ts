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
import { McpToolName, PollStatus, ActorRole, ProgressStatus, SERVER_DEFAULTS } from "./types.js";

const DEFAULT_PORT = SERVER_DEFAULTS.PORT;
const DEFAULT_HOST = SERVER_DEFAULTS.HOST;

async function isServerRunning(
  port: number = DEFAULT_PORT,
  host: string = DEFAULT_HOST,
): Promise<boolean> {
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

async function ensureServerRunning(
  port: number = DEFAULT_PORT,
  host: string = DEFAULT_HOST,
): Promise<void> {
  if (await isServerRunning(port, host)) return;
  const server = new ZenServer({ port, host });
  await server.start();
}

export function createMcpServer(store = new SessionStore()): Server {
  const server = new Server(
    {
      name: "zenspec",
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
          name: McpToolName.OpenReview,
          description:
            "Start the ZenSpec review daemon and open a Markdown or HTML document in the browser for interactive human review. By default, autoPoll is enabled (autoPoll: true), which automatically waits/polls until the human reviewer submits annotations, answers questions, or explicitly approves the plan. MANDATORY GATE: You MUST NOT start implementing features or scaffolding files until the plan is approved (approved: true).",
          inputSchema: {
            type: "object",
            properties: {
              filePath: {
                type: "string",
                description: "Path to the Markdown or HTML document to review.",
              },
              autoPoll: {
                type: "boolean",
                description:
                  "Whether to wait/poll for human reviewer feedback or plan approval in this call (default: true). Set to false to detach without blocking.",
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
          name: McpToolName.PollFeedback,
          description:
            "Long-poll until human reviewer submits annotations, suggestions, question selections, or approves the plan. IMPORTANT: If approved is false or status is 'feedback', the agent MUST NOT start implementing features; it must continue updating the spec or providing information.",
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
          name: McpToolName.ApprovePlan,
          description:
            "Approve a plan/artifact and authorize the agent to proceed with implementation.",
          inputSchema: {
            type: "object",
            properties: {
              filePath: {
                type: "string",
                description: "Path to the reviewed document.",
              },
              notes: {
                type: "string",
                description: "Optional approval note.",
              },
            },
            required: ["filePath"],
          },
        },
        {
          name: McpToolName.Reply,
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
          name: McpToolName.Progress,
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
                enum: [ProgressStatus.Running, ProgressStatus.Done, ProgressStatus.Error],
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
          name: McpToolName.EndSession,
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
          name: McpToolName.GetStatus,
          description: "List all active Zen AXI review sessions and queued feedback counts.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: McpToolName.ExportAdr,
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

    if (name === McpToolName.OpenReview) {
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

      const shouldAutoPoll = args?.autoPoll !== false;

      if (shouldAutoPoll) {
        if (session.queuedPrompts.length > 0) {
          const prompts = store.takeQueuedPrompts(session.key);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  session.approved
                    ? {
                        status: PollStatus.Approved,
                        file: session.filePath,
                        approved: true,
                        approvedAt: session.approvedAt,
                        prompts,
                        message: "Plan has been explicitly approved by the reviewer.",
                        sessionEnded: session.ended,
                        endedBy: session.endedBy,
                      }
                    : {
                        status: PollStatus.Feedback,
                        file: session.filePath,
                        prompts,
                        approved: false,
                        sessionEnded: session.ended,
                        endedBy: session.endedBy,
                      },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (session.approved) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: PollStatus.Approved,
                    file: session.filePath,
                    approved: true,
                    approvedAt: session.approvedAt,
                    message:
                      "Plan has been explicitly approved by the reviewer. You may now proceed with implementation.",
                    sessionEnded: session.ended,
                    endedBy: session.endedBy,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const pollResult = await new Promise((resolve) => {
          store.registerPollWaiter(session.key, (res) => resolve(res));
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(pollResult, null, 2),
            },
          ],
        };
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
                approved: session.approved,
                instruction:
                  "MANDATORY: Call zen_poll_feedback next to wait for human review and plan approval before implementing any code.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === McpToolName.PollFeedback) {
      const filePath = String(args?.filePath || "");
      const canonical = fs.existsSync(filePath)
        ? fs.realpathSync(filePath)
        : path.resolve(filePath);
      const key = sessionKey(canonical);
      const session = store.getOrCreateSession(canonical);

      if (args?.agentReply) {
        store.addChatMessage(key, ActorRole.Agent, String(args.agentReply));
      }

      if (session.queuedPrompts.length > 0) {
        const prompts = store.takeQueuedPrompts(key);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                session.approved
                  ? {
                      status: PollStatus.Approved,
                      file: session.filePath,
                      approved: true,
                      approvedAt: session.approvedAt,
                      prompts,
                      message: "Plan has been explicitly approved by the reviewer.",
                      sessionEnded: session.ended,
                      endedBy: session.endedBy,
                    }
                  : {
                      status: PollStatus.Feedback,
                      file: session.filePath,
                      prompts,
                      approved: false,
                      sessionEnded: session.ended,
                      endedBy: session.endedBy,
                    },
              ),
            },
          ],
        };
      }

      if (session.approved) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: PollStatus.Approved,
                file: session.filePath,
                approved: true,
                approvedAt: session.approvedAt,
                message:
                  "Plan has been explicitly approved by the reviewer. You may now proceed with implementation.",
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
                status: PollStatus.Ended,
                file: session.filePath,
                approved: session.approved,
                endedBy: session.endedBy,
                message: `Session was concluded by ${session.endedBy || ActorRole.User}.`,
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

    if (name === McpToolName.ApprovePlan) {
      const filePath = String(args?.filePath || "");
      const canonical = fs.existsSync(filePath)
        ? fs.realpathSync(filePath)
        : path.resolve(filePath);
      const session = store.getOrCreateSession(canonical);
      const notes = args?.notes ? String(args.notes) : undefined;
      store.approveSession(session.key, notes);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              approved: true,
              approvedAt: session.approvedAt,
              file: session.filePath,
            }),
          },
        ],
      };
    }

    if (name === McpToolName.Reply) {
      const filePath = String(args?.filePath || "");
      const message = String(args?.message || "");
      const canonical = fs.existsSync(filePath)
        ? fs.realpathSync(filePath)
        : path.resolve(filePath);
      const session = store.getOrCreateSession(canonical);
      const msg = store.addChatMessage(session.key, ActorRole.Agent, message);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, messageId: msg.id }),
          },
        ],
      };
    }

    if (name === McpToolName.Progress) {
      const filePath = String(args?.filePath || "");
      const step = String(args?.step || "");
      const status = (args?.status as any) || ProgressStatus.Running;
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

    if (name === McpToolName.EndSession) {
      const filePath = String(args?.filePath || "");
      const canonical = fs.existsSync(filePath)
        ? fs.realpathSync(filePath)
        : path.resolve(filePath);
      const session = store.getOrCreateSession(canonical);
      store.endSession(session.key, ActorRole.Agent);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, endedBy: ActorRole.Agent }),
          },
        ],
      };
    }

    if (name === McpToolName.GetStatus) {
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

    if (name === McpToolName.ExportAdr) {
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

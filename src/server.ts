import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { SessionStore, sessionKey, scanWorkspaceDocuments } from "./session-store.js";
import { renderMarkdownWithSourceLines } from "./sourcemap.js";
import { generateADRDocument } from "./adr.js";
import {
  PollResponse,
  PromptItem,
  AgentProgressUpdate,
  SERVER_DEFAULTS,
  ServerEvent,
  PollStatus,
  AgentPresence,
  ActorRole,
  DocType,
  ProgressStatus,
  PromptTag,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getClientDir(): string {
  const possiblePaths = [
    path.resolve(__dirname, "client"),
    path.resolve(__dirname, "../dist/client"),
    path.resolve(__dirname, "../client"),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(path.join(p, "app.js"))) {
      return p;
    }
  }
  return path.resolve(__dirname, "client");
}

const CLIENT_DIST_DIR = getClientDir();

export interface ServerOptions {
  port?: number;
  host?: string;
  store?: SessionStore;
}

export class ZenServer {
  public server: http.Server;
  public store: SessionStore;
  public port: number;
  public host: string;
  private watchers: Map<string, ReturnType<typeof chokidar.watch>> = new Map();
  private sseClients: Map<string, Set<http.ServerResponse>> = new Map();

  constructor(options: ServerOptions = {}) {
    this.port = options.port !== undefined ? options.port : SERVER_DEFAULTS.PORT;
    this.host = options.host || SERVER_DEFAULTS.HOST;
    this.store = options.store || new SessionStore();
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  public async start(): Promise<{ port: number; host: string }> {
    const tryListen = (portToTry: number): Promise<{ port: number; host: string }> => {
      return new Promise((resolve, reject) => {
        const onError = (err: any) => {
          this.server.removeListener("listening", onListening);
          if (err.code === "EADDRINUSE" && this.port !== 0 && portToTry < this.port + 10) {
            resolve(tryListen(portToTry + 1));
          } else {
            reject(err);
          }
        };

        const onListening = () => {
          this.server.removeListener("error", onError);
          const addr = this.server.address();
          if (addr && typeof addr === "object") {
            this.port = addr.port;
          }
          resolve({ port: this.port, host: this.host });
        };

        this.server.once("error", onError);
        this.server.once("listening", onListening);
        this.server.listen(portToTry, this.host);
      });
    };

    return tryListen(this.port);
  }

  public async stop(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      await watcher.close();
    }
    this.watchers.clear();

    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  public watchFile(key: string, filePath: string): void {
    if (this.watchers.has(key)) return;
    if (!fs.existsSync(filePath)) return;

    try {
      const watcher = chokidar.watch(filePath, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 20 },
      });

      watcher.on("error", () => {});

      let debounceTimer: NodeJS.Timeout | null = null;
      watcher.on("all", () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            if (fs.existsSync(filePath)) {
              const newContent = fs.readFileSync(filePath, "utf8");
              const diffs = this.store.recordFileUpdate(key, newContent);
              this.emitSSE(key, ServerEvent.Reload, {
                timestamp: Date.now(),
                diffs,
              });
            }
          } catch {
            this.emitSSE(key, ServerEvent.Reload, { timestamp: Date.now() });
          }
        }, 50);
      });

      this.watchers.set(key, watcher);
    } catch {
      // Ignore watch failure
    }
  }

  public watchWorkspace(key: string, workspaceRoot: string): void {
    const wsWatchKey = `ws:${key}`;
    if (this.watchers.has(wsWatchKey)) return;
    if (!fs.existsSync(workspaceRoot)) return;

    // Do not watch system root or root temp dir
    const tmp = os.tmpdir();
    if (
      workspaceRoot === tmp ||
      workspaceRoot === path.dirname(tmp) ||
      workspaceRoot === "/" ||
      workspaceRoot === "/tmp" ||
      workspaceRoot === "/var"
    ) {
      return;
    }

    try {
      const watcher = chokidar.watch(workspaceRoot, {
        ignoreInitial: true,
        depth: 3,
        ignored: (p) =>
          p.includes("node_modules") ||
          p.includes(".git") ||
          p.includes("dist") ||
          p.includes("coverage") ||
          p.includes("Socket") ||
          p.includes("socket"),
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      });

      watcher.on("error", () => {});

      let debounceTimer: NodeJS.Timeout | null = null;
      watcher.on("all", (_event, changedPath) => {
        const ext = path.extname(changedPath).toLowerCase();
        if (ext === ".md" || ext === ".markdown" || ext === ".html" || ext === ".htm") {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            const files = scanWorkspaceDocuments(workspaceRoot, this.store);
            this.emitSSE(key, ServerEvent.Workspace, {
              workspaceRoot,
              files,
              timestamp: Date.now(),
            });

            if (fs.existsSync(changedPath)) {
              try {
                const canonicalChanged = fs.realpathSync(changedPath);
                const fileSession = this.store.getSessionByFile(canonicalChanged);
                if (fileSession) {
                  const newContent = fs.readFileSync(canonicalChanged, "utf8");
                  const diffs = this.store.recordFileUpdate(fileSession.key, newContent);
                  this.emitSSE(key, ServerEvent.Reload, {
                    file: canonicalChanged,
                    relPath: path.relative(workspaceRoot, canonicalChanged),
                    timestamp: Date.now(),
                    diffs,
                  });
                }
              } catch {
                // Ignore
              }
            }
          }, 80);
        }
      });

      this.watchers.set(wsWatchKey, watcher);
    } catch {
      // Ignore watch failure
    }
  }

  private emitSSE(key: string, event: string, data: any): void {
    const clients = this.sseClients.get(key);
    if (!clients) return;

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      res.write(payload);
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS Headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // Health check
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "zenspec", version: "0.1.0", port: this.port }));
      return;
    }

    // Shutdown
    if (pathname === "/shutdown" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Shutting down" }));
      setTimeout(() => this.stop(), 50);
      return;
    }

    // Static client assets: /client/*
    if (pathname.startsWith("/client/")) {
      const relPath = pathname.slice("/client/".length);
      const safePath = path.normalize(path.join(CLIENT_DIST_DIR, relPath));
      if (safePath.startsWith(CLIENT_DIST_DIR) && fs.existsSync(safePath)) {
        const ext = path.extname(safePath);
        const mimeTypes: Record<string, string> = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".mjs": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
        };
        res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
        fs.createReadStream(safePath).pipe(res);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    // Main session route: / or /session/:key
    if (pathname === "/" || pathname.startsWith("/session/")) {
      const indexPath = path.join(CLIENT_DIST_DIR, "index.html");
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        fs.createReadStream(indexPath).pipe(res);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!DOCTYPE html><html><body><h1>Zen AXI Server Running</h1></body></html>");
      return;
    }

    // SSE Events: /events/:key
    const eventsMatch = pathname.match(/^\/events\/([a-zA-Z0-9]+)$/);
    if (eventsMatch && req.method === "GET") {
      const key = eventsMatch[1];
      const session = this.store.getSession(key);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("Session not found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write("\n");

      // Register SSE client
      let clientSet = this.sseClients.get(key);
      if (!clientSet) {
        clientSet = new Set();
        this.sseClients.set(key, clientSet);
      }
      clientSet.add(res);

      this.watchFile(key, session.canonicalPath);
      const wsRoot = session.workspaceRoot || path.dirname(session.canonicalPath);
      this.watchWorkspace(key, wsRoot);

      // Send initial presence, progress, diffs, approval state, prompts, and workspace
      res.write(
        `event: ${ServerEvent.Presence}\ndata: ${JSON.stringify({ presence: session.presence })}\n\n`,
      );
      if (session.approved) {
        res.write(
          `event: ${ServerEvent.Approved}\ndata: ${JSON.stringify({ approved: true, approvedAt: session.approvedAt })}\n\n`,
        );
      }
      if (session.activeProgress) {
        res.write(
          `event: ${ServerEvent.Progress}\ndata: ${JSON.stringify(session.activeProgress)}\n\n`,
        );
      }
      if (session.diffs && session.diffs.length > 0) {
        res.write(
          `event: ${ServerEvent.Diff}\ndata: ${JSON.stringify({ diffs: session.diffs })}\n\n`,
        );
      }
      if (session.ended) {
        res.write(
          `event: ${ServerEvent.Ended}\ndata: ${JSON.stringify({ endedBy: session.endedBy })}\n\n`,
        );
      }

      // Initial prompts and workspace files
      res.write(
        `event: ${ServerEvent.Prompts}\ndata: ${JSON.stringify({
          queued: session.queuedPrompts,
          history: session.promptHistory || [],
        })}\n\n`,
      );
      const initialWorkspaceFiles = scanWorkspaceDocuments(wsRoot, this.store);
      res.write(
        `event: ${ServerEvent.Workspace}\ndata: ${JSON.stringify({
          workspaceRoot: wsRoot,
          files: initialWorkspaceFiles,
        })}\n\n`,
      );

      // Event listeners
      const onPresence = (presence: string) => {
        res.write(`event: ${ServerEvent.Presence}\ndata: ${JSON.stringify({ presence })}\n\n`);
      };
      const onProgress = (prog: any) => {
        res.write(`event: ${ServerEvent.Progress}\ndata: ${JSON.stringify(prog)}\n\n`);
      };
      const onDiff = (diffData: any) => {
        res.write(`event: ${ServerEvent.Diff}\ndata: ${JSON.stringify(diffData)}\n\n`);
      };
      const onChat = (msg: any) => {
        res.write(`event: ${ServerEvent.Chat}\ndata: ${JSON.stringify(msg)}\n\n`);
      };
      const onApproved = (approvedData: any) => {
        res.write(`event: ${ServerEvent.Approved}\ndata: ${JSON.stringify(approvedData)}\n\n`);
      };
      const onEnded = (ended: any) => {
        res.write(`event: ${ServerEvent.Ended}\ndata: ${JSON.stringify(ended)}\n\n`);
      };
      const onPrompts = (promptsData: any) => {
        res.write(`event: ${ServerEvent.Prompts}\ndata: ${JSON.stringify(promptsData)}\n\n`);
      };

      this.store.on(`${ServerEvent.Presence}:${key}`, onPresence);
      this.store.on(`${ServerEvent.Progress}:${key}`, onProgress);
      this.store.on(`${ServerEvent.Diff}:${key}`, onDiff);
      this.store.on(`${ServerEvent.Chat}:${key}`, onChat);
      this.store.on(`${ServerEvent.Approved}:${key}`, onApproved);
      this.store.on(`${ServerEvent.Ended}:${key}`, onEnded);
      this.store.on(`${ServerEvent.Prompts}:${key}`, onPrompts);

      req.on("close", () => {
        clientSet?.delete(res);
        this.store.off(`${ServerEvent.Presence}:${key}`, onPresence);
        this.store.off(`${ServerEvent.Progress}:${key}`, onProgress);
        this.store.off(`${ServerEvent.Diff}:${key}`, onDiff);
        this.store.off(`${ServerEvent.Chat}:${key}`, onChat);
        this.store.off(`${ServerEvent.Approved}:${key}`, onApproved);
        this.store.off(`${ServerEvent.Ended}:${key}`, onEnded);
        this.store.off(`${ServerEvent.Prompts}:${key}`, onPrompts);
      });
      return;
    }

    // Document content API: /api/:key/document
    const docMatch = pathname.match(/^\/api\/([a-zA-Z0-9]+)\/document$/);
    if (docMatch && req.method === "GET") {
      const key = docMatch[1];
      const session = this.store.getSession(key);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      let filePathToRead = session.canonicalPath;
      const targetQueryFile = parsedUrl.searchParams.get("file");
      if (targetQueryFile && session.workspaceRoot) {
        const candidate = path.resolve(session.workspaceRoot, targetQueryFile);
        if (candidate.startsWith(session.workspaceRoot) && fs.existsSync(candidate)) {
          filePathToRead = candidate;
        }
      }

      if (!fs.existsSync(filePathToRead)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Document not found" }));
        return;
      }

      const effectiveSession =
        filePathToRead === session.canonicalPath
          ? session
          : this.store.getOrCreateSession(filePathToRead);

      this.watchFile(key, filePathToRead);
      if (effectiveSession.key !== key) {
        this.watchFile(effectiveSession.key, filePathToRead);
      }

      const raw = fs.readFileSync(filePathToRead, "utf8");
      const stat = fs.statSync(filePathToRead);
      const ext = path.extname(filePathToRead).toLowerCase();
      const docType = ext === ".html" || ext === ".htm" ? DocType.Html : DocType.Markdown;
      const renderedHtml = docType === DocType.Markdown ? renderMarkdownWithSourceLines(raw) : raw;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          key: effectiveSession.key,
          file:
            path.relative(session.workspaceRoot || path.dirname(filePathToRead), filePathToRead) ||
            path.basename(filePathToRead),
          fullPath: filePathToRead,
          docType,
          raw,
          renderedHtml,
          lastModified: stat.mtimeMs,
          ended: effectiveSession.ended,
          endedBy: effectiveSession.endedBy,
          approved: effectiveSession.approved || false,
          approvedAt: effectiveSession.approvedAt,
          presence: effectiveSession.presence,
          activeProgress: effectiveSession.activeProgress,
          queuedPrompts: effectiveSession.queuedPrompts || [],
          promptHistory: effectiveSession.promptHistory || [],
          resolvedPrompts: (effectiveSession.promptHistory || []).filter(
            (p) => p.status === "resolved",
          ),
          chatHistory: effectiveSession.chatHistory,
          diffs: effectiveSession.diffs || [],
        }),
      );
      return;
    }

    // Workspace files API: /api/workspace or /api/:key/workspace
    const wsMatch = pathname.match(/^\/api\/(?:([a-zA-Z0-9]+)\/)?workspace$/);
    if (wsMatch && req.method === "GET") {
      const key = wsMatch[1];
      const allSessions = this.store.getAllSessions();
      const session = key
        ? this.store.getSession(key)
        : allSessions.find((s) => !s.ended) || allSessions[0];

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const root = session.workspaceRoot || path.dirname(session.canonicalPath);
      const files = scanWorkspaceDocuments(root, this.store);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ root, workspaceRoot: root, currentFile: session.filePath, files }));
      return;
    }

    // ADR Materialization API: /api/:key/adr
    const adrMatch = pathname.match(/^\/api\/([a-zA-Z0-9]+)\/adr$/);
    if (adrMatch && req.method === "GET") {
      const key = adrMatch[1];
      const session = this.store.getSession(key);

      if (!session || !fs.existsSync(session.canonicalPath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session or file not found" }));
        return;
      }

      const raw = fs.readFileSync(session.canonicalPath, "utf8");
      const adrMarkdown = generateADRDocument({ session, docContent: raw });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ adr: adrMarkdown, adrMarkdown }));
      return;
    }

    // Agent Progress Telemetry endpoint: /api/:key/progress
    const progMatch = pathname.match(/^\/api\/([a-zA-Z0-9]+)\/progress$/);
    if (progMatch && req.method === "POST") {
      const key = progMatch[1];
      const session = this.store.getSession(key);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const body = await readJsonBody(req);
      const update: AgentProgressUpdate = {
        id: `prog-${Date.now()}`,
        timestamp: new Date().toISOString(),
        step: body?.step || "Executing step...",
        status: body?.status || ProgressStatus.Running,
        details: body?.details,
      };

      this.store.setProgress(key, update);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, progress: update }));
      return;
    }

    // Long-polling Agent Poll API: /api/poll?key=... or ?file=...
    if (pathname === "/api/poll" && req.method === "GET") {
      let key = parsedUrl.searchParams.get("key");
      const file = parsedUrl.searchParams.get("file");

      if (!key && file) {
        const canonical = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
        key = sessionKey(canonical);
      }

      if (!key) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing key or file parameter" }));
        return;
      }

      const session = this.store.getSession(key);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      this.store.setPresence(key, AgentPresence.Listening);

      if (session.queuedPrompts.length > 0) {
        const prompts = this.store.takeQueuedPrompts(key);
        this.store.setPresence(key, AgentPresence.Working);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: PollStatus.Feedback,
            file: session.filePath,
            prompts,
            sessionEnded: session.ended,
            endedBy: session.endedBy,
          } as PollResponse),
        );
        return;
      }

      if (session.ended) {
        this.store.setPresence(key, AgentPresence.Waiting);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: PollStatus.Ended,
            file: session.filePath,
            endedBy: session.endedBy,
            message: `Session concluded by ${session.endedBy || ActorRole.User}.`,
          } as PollResponse),
        );
        return;
      }

      res.setHeader("Content-Type", "application/json");

      let isDone = false;
      const waiter = (pollRes: PollResponse) => {
        if (isDone) return;
        isDone = true;
        clearInterval(heartbeat);
        if (pollRes.status === PollStatus.Feedback) {
          this.store.setPresence(key, AgentPresence.Working);
        } else {
          this.store.setPresence(key, AgentPresence.Waiting);
        }
        res.end(JSON.stringify(pollRes));
      };

      this.store.registerPollWaiter(key, waiter);

      const heartbeat = setInterval(() => {
        if (isDone) {
          clearInterval(heartbeat);
          return;
        }
        res.write(" ");
      }, 15000);

      req.on("close", () => {
        isDone = true;
        clearInterval(heartbeat);
        this.store.removePollWaiter(key, waiter);
        if (session.presence === AgentPresence.Listening) {
          this.store.setPresence(key, AgentPresence.Waiting);
        }
      });
      return;
    }

    // Submit prompts from browser: /api/:key/prompts
    const promptMatch = pathname.match(/^\/api\/([a-zA-Z0-9]+)\/prompts$/);
    if (promptMatch && req.method === "POST") {
      const key = promptMatch[1];
      const session = this.store.getSession(key);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const body = await readJsonBody(req);
      const prompts: PromptItem[] = Array.isArray(body?.prompts) ? body.prompts : [];
      const preparedPrompts: PromptItem[] = [];

      for (const p of prompts) {
        const item: PromptItem = {
          id: p.id || `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          tag: p.tag || PromptTag.Annotation,
          text: p.text || "",
          target: p.target,
          createdAt: p.createdAt || new Date().toISOString(),
          status: "submitted",
        };
        preparedPrompts.push(item);
        this.store.queuePrompt(key, item);
      }

      this.store.recordSubmittedPrompts(key, preparedPrompts);

      if (body?.endSession) {
        this.store.endSession(key, ActorRole.User);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          count: prompts.length,
          queued: session.queuedPrompts,
          history: session.promptHistory,
        }),
      );
      return;
    }

    // Resolve prompt endpoint: /api/:key/prompts/resolve
    const resolveMatch = pathname.match(/^\/api\/([a-zA-Z0-9]+)\/prompts\/resolve$/);
    if (resolveMatch && req.method === "POST") {
      const key = resolveMatch[1];
      const session = this.store.getSession(key);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const body = await readJsonBody(req);
      const promptId = body?.promptId;
      if (!promptId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing promptId" }));
        return;
      }

      const ok = this.store.resolvePrompt(key, promptId, {
        startLine: body.startLine,
        endLine: body.endLine,
        diffSummary: body.diffSummary,
        agentReply: body.agentReply,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: ok, history: session.promptHistory }));
      return;
    }

    // Agent reply endpoint: /api/:key/reply
    const replyMatch = pathname.match(/^\/api\/([a-zA-Z0-9]+)\/reply$/);
    if (replyMatch && req.method === "POST") {
      const key = replyMatch[1];
      const session = this.store.getSession(key);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const body = await readJsonBody(req);
      const messageText = body?.message || body?.text || "";

      if (messageText) {
        this.store.addChatMessage(key, ActorRole.Agent, messageText);
      }

      this.store.setPresence(key, AgentPresence.Waiting);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Approve session endpoint: /api/:key/approve
    const approveMatch = pathname.match(/^\/api\/([a-zA-Z0-9]+)\/approve$/);
    if (approveMatch && req.method === "POST") {
      const key = approveMatch[1];
      const session = this.store.getSession(key);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const body = await readJsonBody(req);
      const notes = body?.notes || body?.message || "";
      this.store.approveSession(key, notes);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          approved: true,
          approvedAt: session.approvedAt,
          file: session.filePath,
        }),
      );
      return;
    }

    // End session endpoint: /api/:key/end
    const endMatch = pathname.match(/^\/api\/([a-zA-Z0-9]+)\/end$/);
    if (endMatch && req.method === "POST") {
      const key = endMatch[1];
      const session = this.store.getSession(key);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const body = await readJsonBody(req);
      const endedBy = body?.endedBy || ActorRole.User;
      this.store.endSession(key, endedBy);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, endedBy }));
      return;
    }

    // 404 Fallback
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { SessionStore, sessionKey, scanWorkspaceDocuments } from "./session-store.js";
import { renderMarkdownWithSourceLines } from "./sourcemap.js";
import { generateADRDocument } from "./adr.js";
import { PollResponse, PromptItem, AgentProgressUpdate } from "./types.js";

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
    this.port = options.port !== undefined ? options.port : 4388;
    this.host = options.host || "127.0.0.1";
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

    const watcher = chokidar.watch(filePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 20 },
    });

    let debounceTimer: NodeJS.Timeout | null = null;
    watcher.on("all", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          if (fs.existsSync(filePath)) {
            const newContent = fs.readFileSync(filePath, "utf8");
            const diffs = this.store.recordFileUpdate(key, newContent);
            this.emitSSE(key, "reload", {
              timestamp: Date.now(),
              diffs,
            });
          }
        } catch {
          this.emitSSE(key, "reload", { timestamp: Date.now() });
        }
      }, 50);
    });

    this.watchers.set(key, watcher);
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
        res.writeHead(404, { "Content-Type": "text/plain" });
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

      // Send initial presence, progress, diffs, and approval state
      res.write(`event: presence\ndata: ${JSON.stringify({ presence: session.presence })}\n\n`);
      if (session.approved) {
        res.write(
          `event: approved\ndata: ${JSON.stringify({ approved: true, approvedAt: session.approvedAt })}\n\n`,
        );
      }
      if (session.activeProgress) {
        res.write(`event: progress\ndata: ${JSON.stringify(session.activeProgress)}\n\n`);
      }
      if (session.diffs && session.diffs.length > 0) {
        res.write(`event: diff\ndata: ${JSON.stringify({ diffs: session.diffs })}\n\n`);
      }
      if (session.ended) {
        res.write(`event: ended\ndata: ${JSON.stringify({ endedBy: session.endedBy })}\n\n`);
      }

      // Event listeners
      const onPresence = (presence: string) => {
        res.write(`event: presence\ndata: ${JSON.stringify({ presence })}\n\n`);
      };
      const onProgress = (prog: any) => {
        res.write(`event: progress\ndata: ${JSON.stringify(prog)}\n\n`);
      };
      const onDiff = (diffData: any) => {
        res.write(`event: diff\ndata: ${JSON.stringify(diffData)}\n\n`);
      };
      const onChat = (msg: any) => {
        res.write(`event: chat\ndata: ${JSON.stringify(msg)}\n\n`);
      };
      const onApproved = (approvedData: any) => {
        res.write(`event: approved\ndata: ${JSON.stringify(approvedData)}\n\n`);
      };
      const onEnded = (ended: any) => {
        res.write(`event: ended\ndata: ${JSON.stringify(ended)}\n\n`);
      };

      this.store.on(`presence:${key}`, onPresence);
      this.store.on(`progress:${key}`, onProgress);
      this.store.on(`diff:${key}`, onDiff);
      this.store.on(`chat:${key}`, onChat);
      this.store.on(`approved:${key}`, onApproved);
      this.store.on(`ended:${key}`, onEnded);

      req.on("close", () => {
        clientSet?.delete(res);
        this.store.off(`presence:${key}`, onPresence);
        this.store.off(`progress:${key}`, onProgress);
        this.store.off(`diff:${key}`, onDiff);
        this.store.off(`chat:${key}`, onChat);
        this.store.off(`approved:${key}`, onApproved);
        this.store.off(`ended:${key}`, onEnded);
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

      const raw = fs.readFileSync(filePathToRead, "utf8");
      const stat = fs.statSync(filePathToRead);
      const ext = path.extname(filePathToRead).toLowerCase();
      const docType = ext === ".html" || ext === ".htm" ? "html" : "markdown";
      const renderedHtml = docType === "markdown" ? renderMarkdownWithSourceLines(raw) : raw;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          key: session.key,
          file:
            path.relative(session.workspaceRoot || path.dirname(filePathToRead), filePathToRead) ||
            path.basename(filePathToRead),
          fullPath: filePathToRead,
          docType,
          raw,
          renderedHtml,
          lastModified: stat.mtimeMs,
          ended: session.ended,
          endedBy: session.endedBy,
          approved: session.approved || false,
          approvedAt: session.approvedAt,
          presence: session.presence,
          activeProgress: session.activeProgress,
          chatHistory: session.chatHistory,
          diffs: session.diffs || [],
        }),
      );
      return;
    }

    // Workspace files API: /api/:key/workspace
    const wsMatch = pathname.match(/^\/api\/([a-zA-Z0-9]+)\/workspace$/);
    if (wsMatch && req.method === "GET") {
      const key = wsMatch[1];
      const session = this.store.getSession(key);

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const root = session.workspaceRoot || path.dirname(session.canonicalPath);
      const files = scanWorkspaceDocuments(root);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ root, workspaceRoot: root, files }));
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
        status: body?.status || "running",
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

      this.store.setPresence(key, "listening");

      if (session.queuedPrompts.length > 0) {
        const prompts = this.store.takeQueuedPrompts(key);
        this.store.setPresence(key, "working");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "feedback",
            file: session.filePath,
            prompts,
            sessionEnded: session.ended,
            endedBy: session.endedBy,
          } as PollResponse),
        );
        return;
      }

      if (session.ended) {
        this.store.setPresence(key, "waiting");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ended",
            file: session.filePath,
            endedBy: session.endedBy,
            message: `Session concluded by ${session.endedBy || "user"}.`,
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
        if (pollRes.status === "feedback") {
          this.store.setPresence(key, "working");
        } else {
          this.store.setPresence(key, "waiting");
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
        if (session.presence === "listening") {
          this.store.setPresence(key, "waiting");
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

      for (const p of prompts) {
        this.store.queuePrompt(key, {
          id: p.id || `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          tag: p.tag || "annotation",
          text: p.text || "",
          target: p.target,
          createdAt: p.createdAt || new Date().toISOString(),
        });
      }

      if (body?.endSession) {
        this.store.endSession(key, "user");
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, count: prompts.length }));
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
        this.store.addChatMessage(key, "agent", messageText);
      }

      this.store.setPresence(key, "waiting");

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
      const endedBy = body?.endedBy || "user";
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

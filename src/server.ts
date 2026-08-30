import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { SessionStore, sessionKey } from "./session-store.js";
import { renderMarkdownWithSourceLines } from "./sourcemap.js";
import { PollResponse, PromptItem } from "./types.js";

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
    return new Promise((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve({ port: this.port, host: this.host });
      });
    });
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
        this.emitSSE(key, "reload", {
          timestamp: Date.now(),
        });
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
      res.end(JSON.stringify({ ok: true, app: "zen-axi", version: "0.1.0" }));
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
      // Fallback simple HTML shell if dist/client/index.html is not yet built
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

      // Start watching the file
      this.watchFile(key, session.canonicalPath);

      // Send initial presence and state snapshot
      res.write(`event: presence\ndata: ${JSON.stringify({ presence: session.presence })}\n\n`);
      if (session.ended) {
        res.write(`event: ended\ndata: ${JSON.stringify({ endedBy: session.endedBy })}\n\n`);
      }

      // Event listeners for session store
      const onPresence = (presence: string) => {
        res.write(`event: presence\ndata: ${JSON.stringify({ presence })}\n\n`);
      };
      const onChat = (msg: any) => {
        res.write(`event: chat\ndata: ${JSON.stringify(msg)}\n\n`);
      };
      const onEnded = (ended: any) => {
        res.write(`event: ended\ndata: ${JSON.stringify(ended)}\n\n`);
      };

      this.store.on(`presence:${key}`, onPresence);
      this.store.on(`chat:${key}`, onChat);
      this.store.on(`ended:${key}`, onEnded);

      req.on("close", () => {
        clientSet?.delete(res);
        this.store.off(`presence:${key}`, onPresence);
        this.store.off(`chat:${key}`, onChat);
        this.store.off(`ended:${key}`, onEnded);
      });
      return;
    }

    // Document content API: /api/:key/document
    const docMatch = pathname.match(/^\/api\/([a-zA-Z0-9]+)\/document$/);
    if (docMatch && req.method === "GET") {
      const key = docMatch[1];
      const session = this.store.getSession(key);

      if (!session || !fs.existsSync(session.canonicalPath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Document not found" }));
        return;
      }

      const raw = fs.readFileSync(session.canonicalPath, "utf8");
      const stat = fs.statSync(session.canonicalPath);
      const renderedHtml =
        session.docType === "markdown" ? renderMarkdownWithSourceLines(raw) : raw;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          key: session.key,
          file: session.filePath,
          docType: session.docType,
          raw,
          renderedHtml,
          lastModified: stat.mtimeMs,
          ended: session.ended,
          endedBy: session.endedBy,
          chatHistory: session.chatHistory,
        }),
      );
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

      // Mark agent presence as listening
      this.store.setPresence(key, "listening");

      // Check if prompts are already queued
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

      // Set JSON header upfront
      res.setHeader("Content-Type", "application/json");

      // Wait for prompts or end
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

      // Heartbeat whitespace bytes to keep long-poll alive through proxies
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

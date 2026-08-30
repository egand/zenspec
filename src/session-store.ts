import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  SessionState,
  PromptItem,
  ChatMessage,
  DocumentType,
  AgentPresenceState,
  AgentProgressUpdate,
  WorkspaceDocumentInfo,
  DiffRange,
  PollResponse,
} from "./types.js";

const STATE_DIR = path.join(os.homedir(), ".zen-axi");
const STATE_FILE = path.join(STATE_DIR, "state.json");

export function sessionKey(canonicalPath: string): string {
  return crypto.createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
}

export function computeLineDiff(oldStr: string, newStr: string): DiffRange[] {
  if (!oldStr || oldStr === newStr) return [];
  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);
  const diffs: DiffRange[] = [];

  let oldIdx = 0;
  let newIdx = 0;

  while (newIdx < newLines.length && oldIdx < oldLines.length) {
    if (newLines[newIdx] === oldLines[oldIdx]) {
      oldIdx++;
      newIdx++;
      continue;
    }

    const startLine = newIdx + 1;
    let oldMatch = -1;
    let newMatch = -1;

    for (let di = 0; di < 30; di++) {
      if (newIdx + di < newLines.length) {
        const found = oldLines.indexOf(newLines[newIdx + di], oldIdx);
        if (found !== -1) {
          oldMatch = found;
          newMatch = newIdx + di;
          break;
        }
      }
    }

    if (newMatch !== -1 && oldMatch !== -1) {
      if (newMatch > newIdx || oldMatch > oldIdx) {
        diffs.push({
          startLine,
          endLine: Math.max(startLine, newMatch),
          type: oldMatch > oldIdx && newMatch > newIdx ? "modified" : "added",
          newText: newLines.slice(newIdx, newMatch).join("\n"),
          oldText: oldLines.slice(oldIdx, oldMatch).join("\n"),
        });
      }
      newIdx = newMatch;
      oldIdx = oldMatch;
    } else {
      diffs.push({
        startLine: newIdx + 1,
        endLine: newLines.length,
        type: "modified",
        newText: newLines.slice(newIdx).join("\n"),
        oldText: oldLines.slice(oldIdx).join("\n"),
      });
      break;
    }
  }

  if (newIdx < newLines.length) {
    diffs.push({
      startLine: newIdx + 1,
      endLine: newLines.length,
      type: "added",
      newText: newLines.slice(newIdx).join("\n"),
    });
  }

  return diffs;
}

export function scanWorkspaceDocuments(dirPath: string): WorkspaceDocumentInfo[] {
  const results: WorkspaceDocumentInfo[] = [];
  if (!fs.existsSync(dirPath)) return results;

  function walk(current: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (ent.name.startsWith(".") || ent.name === "node_modules" || ent.name === "dist") {
        continue;
      }
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (ext === ".md" || ext === ".markdown" || ext === ".html" || ext === ".htm") {
          try {
            const stat = fs.statSync(full);
            results.push({
              relPath: path.relative(dirPath, full),
              absPath: full,
              docType: ext === ".html" || ext === ".htm" ? "html" : "markdown",
              sizeBytes: stat.size,
              lastModified: stat.mtimeMs,
            });
          } catch {
            // Ignore stat errors
          }
        }
      }
    }
  }

  walk(dirPath);
  return results;
}

export class SessionStore extends EventEmitter {
  private sessions: Map<string, SessionState> = new Map();
  private pollWaiters: Map<string, Array<(res: PollResponse) => void>> = new Map();

  constructor() {
    super();
    this.ensureStateDir();
    this.loadState();
  }

  private ensureStateDir(): void {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
  }

  private loadState(): void {
    if (!fs.existsSync(STATE_FILE)) return;
    try {
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const data: Record<string, SessionState> = JSON.parse(raw);
      for (const [k, v] of Object.entries(data)) {
        this.sessions.set(k, v);
      }
    } catch {
      // If state is corrupt, start fresh
    }
  }

  private persistState(): void {
    try {
      this.ensureStateDir();
      const obj: Record<string, SessionState> = {};
      for (const [k, v] of this.sessions.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch {
      // Ignore persist errors
    }
  }

  public getOrCreateSession(targetFile: string, options: { token?: string } = {}): SessionState {
    const isDir = fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory();
    let canonicalPath = targetFile;
    let workspaceRoot = isDir ? targetFile : path.dirname(targetFile);

    if (isDir) {
      const docs = scanWorkspaceDocuments(targetFile);
      const firstDoc = docs.find((d) => d.relPath.endsWith("README.md")) || docs[0];
      canonicalPath = firstDoc ? firstDoc.absPath : path.join(targetFile, "index.md");
      workspaceRoot = targetFile;
    } else {
      canonicalPath = fs.existsSync(targetFile)
        ? fs.realpathSync(targetFile)
        : path.resolve(targetFile);
    }

    const key = sessionKey(canonicalPath);
    let session = this.sessions.get(key);

    const ext = path.extname(canonicalPath).toLowerCase();
    const docType: DocumentType = ext === ".html" || ext === ".htm" ? "html" : "markdown";

    const initialContent = fs.existsSync(canonicalPath)
      ? fs.readFileSync(canonicalPath, "utf8")
      : "";

    if (!session) {
      session = {
        key,
        filePath: targetFile,
        canonicalPath,
        docType,
        token: options.token || crypto.randomBytes(8).toString("hex"),
        workspaceRoot,
        ended: false,
        presence: "waiting",
        queuedPrompts: [],
        chatHistory: [],
        currentContent: initialContent,
        lastModified: fs.existsSync(canonicalPath)
          ? fs.statSync(canonicalPath).mtimeMs
          : Date.now(),
      };
      this.sessions.set(key, session);
      this.persistState();
    } else {
      session.filePath = targetFile;
      session.canonicalPath = canonicalPath;
      session.docType = docType;
      session.workspaceRoot = workspaceRoot;
      if (options.token) session.token = options.token;
      if (!session.currentContent && initialContent) {
        session.currentContent = initialContent;
      }
    }

    return session;
  }

  public getSession(key: string): SessionState | undefined {
    return this.sessions.get(key);
  }

  public getSessionByFile(targetFile: string): SessionState | undefined {
    const canonicalPath = fs.existsSync(targetFile)
      ? fs.realpathSync(targetFile)
      : path.resolve(targetFile);
    return this.sessions.get(sessionKey(canonicalPath));
  }

  public getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  public recordFileUpdate(key: string, newContent: string): DiffRange[] {
    const session = this.sessions.get(key);
    if (!session) return [];

    const oldContent = session.currentContent || "";
    const diffs = computeLineDiff(oldContent, newContent);

    session.previousContent = oldContent;
    session.currentContent = newContent;
    session.diffs = diffs;
    session.lastModified = Date.now();
    this.persistState();

    this.emit(`diff:${key}`, { diffs, lastModified: session.lastModified });
    return diffs;
  }

  public setPresence(key: string, presence: AgentPresenceState): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.presence = presence;
    this.persistState();
    this.emit(`presence:${key}`, presence);
  }

  public setProgress(key: string, update: AgentProgressUpdate): void {
    const session = this.sessions.get(key);
    if (!session) return;

    session.activeProgress = update;
    if (update.status === "running") {
      session.presence = "working";
    }
    this.persistState();
    this.emit(`progress:${key}`, update);
  }

  public queuePrompt(key: string, prompt: PromptItem): void {
    const session = this.sessions.get(key);
    if (!session) return;

    session.queuedPrompts.push(prompt);
    this.persistState();
    this.emit(`prompt:${key}`, prompt);

    this.flushPollWaiters(key);
  }

  public addChatMessage(key: string, sender: "user" | "agent", text: string): ChatMessage {
    const session = this.sessions.get(key);
    const msg: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sender,
      text,
      createdAt: new Date().toISOString(),
    };

    if (session) {
      session.chatHistory.push(msg);
      this.persistState();
      this.emit(`chat:${key}`, msg);
    }

    return msg;
  }

  public endSession(key: string, endedBy: "user" | "agent"): void {
    const session = this.sessions.get(key);
    if (!session) return;

    session.ended = true;
    session.endedBy = endedBy;
    session.presence = "waiting";
    this.persistState();

    this.emit(`ended:${key}`, { endedBy });
    this.flushPollWaiters(key);
  }

  public registerPollWaiter(key: string, waiter: (res: PollResponse) => void): void {
    const existing = this.pollWaiters.get(key);
    if (existing && existing.length > 0) {
      for (const oldWaiter of existing) {
        try {
          oldWaiter({
            status: "superseded",
            file: this.sessions.get(key)?.filePath || "",
            message: "New poll client connected for this session.",
          });
        } catch (err) {
          void err;
        }
      }
    }
    this.pollWaiters.set(key, [waiter]);
  }

  public removePollWaiter(key: string, waiter: (res: PollResponse) => void): void {
    const list = this.pollWaiters.get(key);
    if (!list) return;
    const idx = list.indexOf(waiter);
    if (idx !== -1) list.splice(idx, 1);
  }

  public takeQueuedPrompts(key: string): PromptItem[] {
    const session = this.sessions.get(key);
    if (!session) return [];
    const prompts = [...session.queuedPrompts];
    session.queuedPrompts = [];
    this.persistState();
    return prompts;
  }

  private flushPollWaiters(key: string): void {
    const waiters = this.pollWaiters.get(key);
    if (!waiters || waiters.length === 0) return;

    const session = this.sessions.get(key);
    if (!session) return;

    if (session.queuedPrompts.length > 0) {
      const prompts = this.takeQueuedPrompts(key);
      const response: PollResponse = {
        status: "feedback",
        file: session.filePath,
        prompts,
        sessionEnded: session.ended,
        endedBy: session.endedBy,
      };
      const callbacks = [...waiters];
      this.pollWaiters.set(key, []);
      for (const cb of callbacks) cb(response);
      return;
    }

    if (session.ended) {
      const response: PollResponse = {
        status: "ended",
        file: session.filePath,
        endedBy: session.endedBy,
        message: `Session was concluded by ${session.endedBy || "user"}.`,
      };
      const callbacks = [...waiters];
      this.pollWaiters.set(key, []);
      for (const cb of callbacks) cb(response);
    }
  }
}

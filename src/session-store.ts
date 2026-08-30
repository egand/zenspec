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
  PollResponse,
} from "./types.js";

const STATE_DIR = path.join(os.homedir(), ".zen-axi");
const STATE_FILE = path.join(STATE_DIR, "state.json");

export function sessionKey(canonicalPath: string): string {
  return crypto.createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
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

  public getOrCreateSession(targetFile: string): SessionState {
    const canonicalPath = fs.existsSync(targetFile)
      ? fs.realpathSync(targetFile)
      : path.resolve(targetFile);

    const key = sessionKey(canonicalPath);
    let session = this.sessions.get(key);

    const ext = path.extname(canonicalPath).toLowerCase();
    const docType: DocumentType = ext === ".html" || ext === ".htm" ? "html" : "markdown";

    if (!session) {
      session = {
        key,
        filePath: targetFile,
        canonicalPath,
        docType,
        ended: false,
        presence: "waiting",
        queuedPrompts: [],
        chatHistory: [],
        lastModified: fs.existsSync(canonicalPath)
          ? fs.statSync(canonicalPath).mtimeMs
          : Date.now(),
      };
      this.sessions.set(key, session);
      this.persistState();
    } else {
      // Revive if was ended and we're reopening
      session.filePath = targetFile;
      session.canonicalPath = canonicalPath;
      session.docType = docType;
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

  public setPresence(key: string, presence: AgentPresenceState): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.presence = presence;
    this.persistState();
    this.emit(`presence:${key}`, presence);
  }

  public queuePrompt(key: string, prompt: PromptItem): void {
    const session = this.sessions.get(key);
    if (!session) return;

    session.queuedPrompts.push(prompt);
    this.persistState();
    this.emit(`prompt:${key}`, prompt);

    // If there is an active poll waiter, resolve it
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
    const list = this.pollWaiters.get(key) || [];
    list.push(waiter);
    this.pollWaiters.set(key, list);
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

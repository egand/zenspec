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
  DocType,
  AgentPresence,
  ActorRole,
  ProgressStatus,
  PollStatus,
  DiffType,
  ServerEvent,
  TargetType,
} from "./types.js";

const STATE_DIR = path.join(os.homedir(), ".zenspec");
const STATE_FILE = path.join(STATE_DIR, "state.json");

export function sessionKey(canonicalPath: string): string {
  return crypto.createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
}

export function computeLineDiff(oldStr: string, newStr: string): DiffRange[] {
  if (!oldStr || oldStr === newStr) return [];
  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);

  const m = oldLines.length;
  const n = newLines.length;

  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (oldLines[i] === newLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  interface RawEdit {
    type: "added" | "deleted";
    oldLine: number;
    newLine: number;
  }
  const edits: RawEdit[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.push({ type: "added", oldLine: i + 1, newLine: j });
      j--;
    } else {
      edits.push({ type: "deleted", oldLine: i, newLine: j + 1 });
      i--;
    }
  }
  edits.reverse();

  const diffs: DiffRange[] = [];
  let k = 0;
  while (k < edits.length) {
    const cur = edits[k];
    let startLine = cur.newLine;
    let endLine = cur.newLine;
    let oldStartLine = cur.oldLine;
    let oldEndLine = cur.oldLine;
    let hasAdded = cur.type === "added";
    let hasDeleted = cur.type === "deleted";

    k++;
    while (k < edits.length) {
      const next = edits[k];
      const oldAdjacent = Math.abs(next.oldLine - oldEndLine) <= 1;
      const newAdjacent = Math.abs(next.newLine - endLine) <= 1;
      if (oldAdjacent || newAdjacent) {
        if (next.type === "added") {
          hasAdded = true;
          startLine = Math.min(startLine, next.newLine);
          endLine = Math.max(endLine, next.newLine);
        } else {
          hasDeleted = true;
          oldStartLine = Math.min(oldStartLine, next.oldLine);
          oldEndLine = Math.max(oldEndLine, next.oldLine);
        }
        k++;
      } else {
        break;
      }
    }

    const type =
      hasAdded && hasDeleted ? DiffType.Modified : hasAdded ? DiffType.Added : DiffType.Deleted;
    diffs.push({
      startLine,
      endLine,
      oldStartLine,
      oldEndLine,
      type,
      newText: hasAdded ? newLines.slice(startLine - 1, endLine).join("\n") : "",
      oldText: hasDeleted ? oldLines.slice(oldStartLine - 1, oldEndLine).join("\n") : "",
    });
  }

  return diffs;
}

export function scanWorkspaceDocuments(
  dirPath: string,
  store?: SessionStore,
): WorkspaceDocumentInfo[] {
  const results: WorkspaceDocumentInfo[] = [];
  if (!fs.existsSync(dirPath)) return results;

  function walk(current: string, depth = 0) {
    if (depth > 6) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort entries: directories first, then files alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const ent of entries) {
      if (
        ent.name.startsWith(".") ||
        ent.name === "node_modules" ||
        ent.name === "dist" ||
        ent.name === ".git" ||
        ent.name === "coverage"
      ) {
        continue;
      }
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (ext === ".md" || ext === ".markdown" || ext === ".html" || ext === ".htm") {
          try {
            const stat = fs.statSync(full);
            const canonical = fs.realpathSync(full);
            const key = sessionKey(canonical);
            const session = store?.getSession(key);

            results.push({
              relPath: path.relative(dirPath, full),
              absPath: full,
              docType: ext === ".html" || ext === ".htm" ? DocType.Html : DocType.Markdown,
              sizeBytes: stat.size,
              lastModified: stat.mtimeMs,
              sessionKey: key,
              approved: session?.approved || false,
              queuedCount: session?.queuedPrompts.length || 0,
              resolvedCount:
                session?.promptHistory.filter((p) => p.status === "resolved").length || 0,
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
      canonicalPath = fs.existsSync(targetFile)
        ? fs.realpathSync(targetFile)
        : path.resolve(targetFile);
      workspaceRoot = canonicalPath;
      const docs = scanWorkspaceDocuments(canonicalPath);
      const firstDoc = docs.find((d) => d.relPath.endsWith("README.md")) || docs[0];
      canonicalPath = firstDoc ? firstDoc.absPath : path.join(canonicalPath, "index.md");
    } else {
      canonicalPath = fs.existsSync(targetFile)
        ? fs.realpathSync(targetFile)
        : path.resolve(targetFile);
      if (canonicalPath.startsWith(process.cwd())) {
        workspaceRoot = process.cwd();
      } else {
        workspaceRoot = path.dirname(canonicalPath);
      }
    }

    const key = sessionKey(canonicalPath);
    let session = this.sessions.get(key);

    const ext = path.extname(canonicalPath).toLowerCase();
    const docType: DocumentType =
      ext === ".html" || ext === ".htm" ? DocType.Html : DocType.Markdown;

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
        approved: false,
        presence: AgentPresence.Waiting,
        queuedPrompts: [],
        promptHistory: [],
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
      if (!session.promptHistory) session.promptHistory = [];
      if (session.approved === undefined) session.approved = false;
      if (options.token) session.token = options.token;
      if (!session.currentContent && initialContent) {
        session.currentContent = initialContent;
      }
    }

    return session;
  }

  public getSession(key: string): SessionState | undefined {
    let s = this.sessions.get(key);
    if (!s) {
      this.loadState();
      s = this.sessions.get(key);
    }
    return s;
  }

  public getSessionByFile(targetFile: string): SessionState | undefined {
    const canonicalPath = fs.existsSync(targetFile)
      ? fs.realpathSync(targetFile)
      : path.resolve(targetFile);
    let s = this.sessions.get(sessionKey(canonicalPath));
    if (!s) {
      this.loadState();
      s = this.sessions.get(sessionKey(canonicalPath));
    }
    return s;
  }

  public getAllSessions(): SessionState[] {
    this.loadState();
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

    if (diffs.length > 0) {
      this.resolvePromptsWithDiff(key, diffs);
      this.emit(`${ServerEvent.Prompts}:${key}`, {
        queued: session.queuedPrompts,
        history: session.promptHistory,
      });
    }

    this.persistState();

    this.emit(`${ServerEvent.Diff}:${key}`, { diffs, lastModified: session.lastModified });
    return diffs;
  }

  public setPresence(key: string, presence: AgentPresenceState): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.presence = presence;
    this.persistState();
    this.emit(`${ServerEvent.Presence}:${key}`, presence);
  }

  public setProgress(key: string, update: AgentProgressUpdate): void {
    const session = this.sessions.get(key);
    if (!session) return;

    session.activeProgress = update;
    if (update.status === ProgressStatus.Running) {
      session.presence = AgentPresence.Working;
    }
    this.persistState();
    this.emit(`${ServerEvent.Progress}:${key}`, update);
  }

  public queuePrompt(key: string, prompt: PromptItem): void {
    const session = this.sessions.get(key);
    if (!session) return;

    prompt.status = prompt.status || "pending";

    if (prompt.queueKey) {
      const idx = session.queuedPrompts.findIndex((p) => p.queueKey === prompt.queueKey);
      if (idx !== -1) {
        session.queuedPrompts[idx] = prompt;
      } else {
        session.queuedPrompts.push(prompt);
      }
    } else {
      session.queuedPrompts.push(prompt);
    }

    this.persistState();
    this.emit(`prompt:${key}`, prompt);
    this.emit(`${ServerEvent.Prompts}:${key}`, {
      queued: session.queuedPrompts,
      history: session.promptHistory,
    });

    this.flushPollWaiters(key);
  }

  public recordSubmittedPrompts(key: string, prompts: PromptItem[]): void {
    const session = this.sessions.get(key);
    if (!session) return;
    if (!session.promptHistory) session.promptHistory = [];

    for (const p of prompts) {
      const submittedItem: PromptItem = {
        ...p,
        status: "submitted",
      };

      // Replace or append in prompt history
      const histIdx = session.promptHistory.findIndex(
        (h) => h.id === p.id || (p.queueKey && h.queueKey === p.queueKey),
      );
      if (histIdx !== -1) {
        session.promptHistory[histIdx] = submittedItem;
      } else {
        session.promptHistory.push(submittedItem);
      }
    }

    this.persistState();
    this.emit(`${ServerEvent.Prompts}:${key}`, {
      queued: session.queuedPrompts,
      history: session.promptHistory,
    });
  }

  public resolvePrompt(
    key: string,
    promptId: string,
    resolution: {
      startLine?: number;
      endLine?: number;
      diffSummary?: string;
      agentReply?: string;
    },
  ): boolean {
    const session = this.sessions.get(key);
    if (!session) return false;
    if (!session.promptHistory) session.promptHistory = [];

    const prompt = session.promptHistory.find((p) => p.id === promptId);
    if (!prompt) return false;

    prompt.status = "resolved";
    prompt.resolvedAt = new Date().toISOString();
    prompt.resolution = {
      resolvedAt: prompt.resolvedAt,
      startLine: resolution.startLine,
      endLine: resolution.endLine,
      diffSummary: resolution.diffSummary,
      agentReply: resolution.agentReply,
    };

    this.persistState();
    this.emit(`${ServerEvent.Prompts}:${key}`, {
      queued: session.queuedPrompts,
      history: session.promptHistory,
    });
    return true;
  }

  public resolvePromptsWithDiff(key: string, diffs: DiffRange[]): void {
    const session = this.sessions.get(key);
    if (!session || !diffs || diffs.length === 0) return;
    if (!session.promptHistory) session.promptHistory = [];

    const submitted = session.promptHistory.filter(
      (p) => p.status === "submitted" || p.status === "pending",
    );
    if (submitted.length === 0) return;

    for (const p of submitted) {
      let matchedDiff: DiffRange | undefined;
      const mdTarget = p.target?.type === TargetType.MarkdownRange ? p.target : undefined;

      if (mdTarget && mdTarget.startLine) {
        const targetOld = mdTarget.startLine;
        const targetOldEnd = mdTarget.endLine || targetOld;

        // 1. Match diff with direct overlap or proximity in old coordinates
        matchedDiff = diffs.find(
          (d) =>
            d.oldStartLine !== undefined &&
            d.oldEndLine !== undefined &&
            ((targetOld <= d.oldEndLine && targetOldEnd >= d.oldStartLine) ||
              Math.abs(d.oldStartLine - targetOld) <= 5),
        );

        // 2. If no direct match, find diff with closest distance in old coordinates
        if (!matchedDiff) {
          let minDistance = Infinity;
          for (const d of diffs) {
            if (d.oldStartLine !== undefined) {
              const dist = Math.abs(d.oldStartLine - targetOld);
              if (dist < minDistance) {
                minDistance = dist;
                matchedDiff = d;
              }
            }
          }
        }
      }

      if (!matchedDiff) {
        // Pick primary substantive diff (largest content change), avoiding trivial frontmatter updates
        const nonFrontmatter = diffs.filter(
          (d) => d.startLine > 10 || (d.newText && d.newText.length > 50),
        );
        const candidates = nonFrontmatter.length > 0 ? nonFrontmatter : diffs;
        matchedDiff = candidates.reduce(
          (best, cur) => ((cur.newText?.length || 0) > (best.newText?.length || 0) ? cur : best),
          candidates[0],
        );
      }

      p.status = "resolved";
      p.resolvedAt = new Date().toISOString();
      p.resolution = {
        resolvedAt: p.resolvedAt,
        startLine: matchedDiff.startLine,
        endLine: matchedDiff.endLine,
        diffSummary: matchedDiff.newText ? matchedDiff.newText.slice(0, 150) : undefined,
      };
    }

    this.persistState();
    this.emit(`${ServerEvent.Prompts}:${key}`, {
      queued: session.queuedPrompts,
      history: session.promptHistory,
    });
  }

  public addChatMessage(key: string, sender: ActorRole, text: string): ChatMessage {
    const session = this.sessions.get(key);
    const msg: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sender,
      text,
      createdAt: new Date().toISOString(),
    };

    if (session) {
      session.chatHistory.push(msg);

      // If Agent replied, attach agentReply to recently submitted or resolved prompts that don't have it
      if (sender === ActorRole.Agent && session.promptHistory) {
        for (let i = session.promptHistory.length - 1; i >= 0; i--) {
          const p = session.promptHistory[i];
          if (p.status === "submitted") {
            p.status = "resolved";
            p.resolvedAt = new Date().toISOString();
            p.resolution = {
              resolvedAt: p.resolvedAt,
              startLine:
                p.target?.type === TargetType.MarkdownRange ? p.target.startLine : undefined,
              endLine: p.target?.type === TargetType.MarkdownRange ? p.target.endLine : undefined,
              agentReply: text,
            };
            break;
          } else if (p.status === "resolved" && p.resolution && !p.resolution.agentReply) {
            p.resolution.agentReply = text;
            break;
          }
        }
      }

      this.persistState();
      this.emit(`${ServerEvent.Chat}:${key}`, msg);
      this.emit(`${ServerEvent.Prompts}:${key}`, {
        queued: session.queuedPrompts,
        history: session.promptHistory,
      });
    }

    return msg;
  }

  public approveSession(key: string, notes?: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    session.approved = true;
    session.approvedAt = new Date().toISOString();
    if (notes) {
      this.addChatMessage(key, ActorRole.User, `[Plan Approved] ${notes}`);
    }
    this.persistState();

    this.emit(`${ServerEvent.Approved}:${key}`, { approved: true, approvedAt: session.approvedAt });
    this.flushPollWaiters(key);
  }

  public endSession(key: string, endedBy: ActorRole): void {
    const session = this.sessions.get(key);
    if (!session) return;

    session.ended = true;
    session.endedBy = endedBy;
    session.presence = AgentPresence.Waiting;
    this.persistState();

    this.emit(`${ServerEvent.Ended}:${key}`, { endedBy });
    this.flushPollWaiters(key);
  }

  public registerPollWaiter(key: string, waiter: (res: PollResponse) => void): void {
    const existing = this.pollWaiters.get(key);
    if (existing && existing.length > 0) {
      for (const oldWaiter of existing) {
        try {
          oldWaiter({
            status: PollStatus.Superseded,
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
    if (!session.promptHistory) session.promptHistory = [];

    for (const p of prompts) {
      const submittedItem: PromptItem = {
        ...p,
        status: "submitted",
      };
      const histIdx = session.promptHistory.findIndex((h) => h.id === p.id);
      if (histIdx !== -1) {
        session.promptHistory[histIdx] = submittedItem;
      } else {
        session.promptHistory.push(submittedItem);
      }
    }

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
      const response: PollResponse = session.approved
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
          };
      const callbacks = [...waiters];
      this.pollWaiters.set(key, []);
      for (const cb of callbacks) cb(response);
      return;
    }

    if (session.approved) {
      const response: PollResponse = {
        status: PollStatus.Approved,
        file: session.filePath,
        approved: true,
        approvedAt: session.approvedAt,
        message:
          "Plan has been explicitly approved by the reviewer. You may now proceed with implementation.",
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
        status: PollStatus.Ended,
        file: session.filePath,
        approved: session.approved,
        endedBy: session.endedBy,
        message: `Session was concluded by ${session.endedBy || ActorRole.User}.`,
      };
      const callbacks = [...waiters];
      this.pollWaiters.set(key, []);
      for (const cb of callbacks) cb(response);
    }
  }
}

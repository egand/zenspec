/**
 * On-disk layout of one document (plan §5). The daemon is the only writer, and all writes
 * are synchronous so that a request's appends happen within one tick.
 *
 * repos/<repo-id>/docs/<doc-id>/
 *   doc.json            identity (the file this doc id stands for)
 *   events.jsonl        append-only, one event per line
 *   revisions/<n>.md    revision snapshots
 *   draft.json          the reviewer's pending review (atomic writes)
 *   delivered.json      the last review delivered to the agent, by `review` or the inbox
 *   attachments/<id>.<ext>
 */
import fs from "node:fs";
import path from "node:path";
import type { ZenEvent } from "../core/events.js";
import type { AttachmentRef, DocumentRef, Draft } from "../core/types.js";
import { writeFileAtomic } from "./home.js";
import { probeImage } from "./images.js";

const EXT: Record<AttachmentRef["mime"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MIME = Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime]));

export const reposDir = (home: string) => path.join(home, "repos");
export const docsDir = (home: string, repoId: string) => path.join(reposDir(home), repoId, "docs");

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export const listRepoIds = (home: string) => listDirs(reposDir(home));
export const listDocIds = (home: string, repoId: string) => listDirs(docsDir(home, repoId));

export class DocStorage {
  readonly dir: string;

  constructor(home: string, repoId: string, docId: string) {
    this.dir = path.join(docsDir(home, repoId), docId);
  }

  private file(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  readRef(): DocumentRef | null {
    try {
      return JSON.parse(fs.readFileSync(this.file("doc.json"), "utf8")) as DocumentRef;
    } catch {
      return null;
    }
  }

  create(ref: DocumentRef): void {
    fs.mkdirSync(this.file("revisions"), { recursive: true });
    writeFileAtomic(this.file("doc.json"), JSON.stringify(ref, null, 2) + "\n");
  }

  /**
   * Every parseable line. A torn last line (crash mid-write) is cut off the file, so the next
   * append starts on a line of its own.
   */
  readEvents(): ZenEvent[] {
    const log = this.file("events.jsonl");
    let raw: string;
    try {
      raw = fs.readFileSync(log, "utf8");
    } catch {
      return [];
    }
    const end = raw.lastIndexOf("\n") + 1;
    if (end < raw.length) {
      console.error(`zenspec: dropping a torn last line in ${log}`);
      raw = raw.slice(0, end);
      fs.truncateSync(log, Buffer.byteLength(raw));
    }
    const events: ZenEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as ZenEvent);
      } catch {
        // Skip a corrupt line.
      }
    }
    return events;
  }

  /** One whole line per `write`, so concurrent readers never see half an event. */
  appendEvent(event: ZenEvent): void {
    fs.appendFileSync(this.file("events.jsonl"), JSON.stringify(event) + "\n");
  }

  writeRevision(n: number, content: string): void {
    fs.mkdirSync(this.file("revisions"), { recursive: true });
    writeFileAtomic(this.file("revisions", `${n}.md`), content);
  }

  readRevision(n: number): string | null {
    try {
      return fs.readFileSync(this.file("revisions", `${n}.md`), "utf8");
    } catch {
      return null;
    }
  }

  readDraft(): Draft | null {
    return this.readJson<Draft>("draft.json");
  }

  writeDraft(draft: Draft | null): void {
    if (draft) writeFileAtomic(this.file("draft.json"), JSON.stringify(draft));
    else fs.rmSync(this.file("draft.json"), { force: true });
  }

  readDelivered(): number {
    return this.readJson<{ review: number }>("delivered.json")?.review ?? 0;
  }

  writeDelivered(review: number): void {
    writeFileAtomic(this.file("delivered.json"), JSON.stringify({ review }));
  }

  /** Stores content-addressed bytes; returns the absolute path. Idempotent. */
  writeAttachment(id: string, mime: AttachmentRef["mime"], bytes: Buffer): string {
    const file = this.file("attachments", `${id}.${EXT[mime]}`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, bytes);
    }
    return file;
  }

  /** The stored attachment `id`, described from its bytes, or null if there is none. */
  readAttachmentRef(id: string): AttachmentRef | null {
    const found = this.findAttachment(id);
    const info = found && probeImage(fs.readFileSync(found.path));
    return info && { id, mime: info.mime, width: info.width, height: info.height };
  }

  /** Absolute path and MIME type of a stored attachment, or null. */
  findAttachment(id: string): { path: string; mime: string } | null {
    if (!/^[0-9a-f]{12}$/.test(id)) return null;
    const dir = this.file("attachments");
    const name = listFiles(dir).find((f) => f.startsWith(`${id}.`));
    if (!name) return null;
    return { path: path.join(dir, name), mime: MIME[path.extname(name).slice(1)] ?? "" };
  }

  /** Where an attachment lives, for payloads; falls back to `.png` when not found. */
  attachmentPath(id: string): string {
    return this.findAttachment(id)?.path ?? this.file("attachments", `${id}.png`);
  }

  private readJson<T>(name: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), "utf8")) as T;
    } catch {
      return null;
    }
  }
}

function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

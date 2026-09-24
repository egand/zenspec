/**
 * Documents known to the daemon. Sessions are loaded lazily from disk on first access, and
 * each loaded document's file is watched for live preview and living-plan tracking.
 */
import fs from "node:fs";
import { watch, type FSWatcher } from "chokidar";
import type { DocumentRef } from "../core/types.js";
import { badRequest, notFound } from "./http.js";
import { identify, repoIdOf, repoRootOf, shortHash } from "./identity.js";
import { DocSession, type SessionContext } from "./session.js";
import { DocStorage, listDocIds, listRepoIds } from "./storage.js";

interface Entry {
  session: DocSession;
  watcher: FSWatcher;
  /** Resolves once the watcher is ready to report changes. */
  ready: Promise<void>;
}

export class Registry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly home: string,
    private readonly ctx: SessionContext,
  ) {}

  /** Registers `file` (or returns its registration) and waits until it is watched. */
  async open(file: string): Promise<{ session: DocSession; created: boolean }> {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw notFound(`File not found: ${file}`);
    }
    const ref = this.resolveRef(file);
    const storage = new DocStorage(this.home, ref.repoId, ref.docId);
    const created = storage.readRef() === null;
    if (created) storage.create(ref);
    const entry = this.load(ref.repoId, ref.docId);
    if (!entry) throw new Error(`Failed to load ${ref.repoId}/${ref.docId}`);
    await entry.ready;
    return { session: entry.session, created };
  }

  /** The registered document at `repoId/docId`; 404 when unknown. */
  get(repoId: string, docId: string): DocSession {
    const entry = this.load(repoId, docId);
    if (!entry) throw notFound(`Unknown document: ${repoId}/${docId}`);
    return entry.session;
  }

  /** The registered document for a file path, or null. */
  find(file: string): DocSession | null {
    const ref = this.resolveRef(file);
    return this.load(ref.repoId, ref.docId)?.session ?? null;
  }

  /** Every registered document of the repo containing `p`. */
  inRepoOf(p: string): DocSession[] {
    return this.inRepo(repoIdOf(repoRootOf(p)));
  }

  inRepo(repoId: string): DocSession[] {
    return listDocIds(this.home, repoId).flatMap((docId) => {
      const entry = this.load(repoId, docId);
      return entry ? [entry.session] : [];
    });
  }

  all(): DocSession[] {
    return listRepoIds(this.home).flatMap((repoId) => this.inRepo(repoId));
  }

  /** Waiters and SSE listeners across loaded documents. */
  activity(): number {
    let total = 0;
    for (const { session } of this.entries.values()) total += session.activity;
    return total;
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const { session } of entries) session.abortWaiters();
    await Promise.all(entries.map((e) => e.watcher.close()));
  }

  /**
   * Identity of `file`, with the doc id suffixed by a hash of the path when another file
   * already claimed the same slug (e.g. `a-b.md` and `a/b.md`).
   */
  private resolveRef(file: string): DocumentRef {
    const ref = identify(file);
    const existing = new DocStorage(this.home, ref.repoId, ref.docId).readRef();
    if (existing && existing.relPath !== ref.relPath) {
      ref.docId = `${ref.docId}-${shortHash(ref.relPath)}`;
    }
    return ref;
  }

  private load(repoId: string, docId: string): Entry | null {
    const key = `${repoId}/${docId}`;
    const cached = this.entries.get(key);
    if (cached) return cached;
    if (!isSafeSegment(repoId) || !isSafeSegment(docId)) throw badRequest("Invalid document id");
    const storage = new DocStorage(this.home, repoId, docId);
    const ref = storage.readRef();
    if (!ref) return null;
    const session = new DocSession(ref, storage, this.ctx);
    const watcher = watch(session.file, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 30, pollInterval: 10 },
    });
    const onChange = () => session.onDiskChange();
    watcher.on("add", onChange).on("change", onChange);
    watcher.on("error", (err) => console.error(`zenspec: watcher error: ${String(err)}`));
    const ready = new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
    const entry = { session, watcher, ready };
    this.entries.set(key, entry);
    return entry;
  }
}

function isSafeSegment(segment: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(segment);
}

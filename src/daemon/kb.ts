/**
 * Knowledge-base index (plan §11): Markdown notes under `root/notesDir`, matched by file slug,
 * frontmatter `title`, and `aliases`. Kept fresh by a watcher.
 */
import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { parse } from "yaml";
import type { KbNote } from "../core/api.js";
import type { KnowledgeBaseConfig } from "../core/config.js";
import type { ExplainTarget } from "../core/format-payload.js";
import { tildify } from "./home.js";

/** Lowercase, punctuation-insensitive key: "JSON", "json" and "Json!" all match `json`. */
export function termKey(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

export class KnowledgeBase {
  private readonly notes = new Map<string, KbNote>(); // by absolute path
  private readonly byKey = new Map<string, KbNote>();
  private watcher?: FSWatcher;

  constructor(readonly config: KnowledgeBaseConfig | undefined) {}

  get configured(): boolean {
    return this.config !== undefined;
  }

  private get notesRoot(): string | undefined {
    return this.config && path.join(this.config.root, this.config.notesDir);
  }

  /** Builds the index and starts watching for changes. */
  async start(): Promise<void> {
    const dir = this.notesRoot;
    if (!dir) return;
    for (const file of walkMarkdown(dir)) this.index(file);
    this.rebuildKeys();
    if (!fs.existsSync(dir)) return;
    const watcher = watch(dir, { ignoreInitial: true });
    const refresh = (file: string) => {
      if (file.endsWith(".md")) this.index(file);
      this.rebuildKeys();
    };
    watcher.on("add", refresh).on("change", refresh);
    watcher.on("unlink", (file) => {
      this.notes.delete(file);
      this.rebuildKeys();
    });
    this.watcher = watcher;
    await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  list(): KbNote[] {
    return [...this.notes.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  lookup(term: string): KbNote | null {
    return this.byKey.get(termKey(term)) ?? null;
  }

  /** Where the agent should write a note for `term` (§11), when none exists yet. */
  explainTarget(term: string): ExplainTarget | undefined {
    const dir = this.notesRoot;
    if (!this.config || !dir || this.lookup(term)) return undefined;
    const slug = termKey(term) || "note";
    return {
      saveTo: tildify(path.join(dir, `${slug}.md`)),
      ...(this.config.template && {
        template: tildify(path.join(this.config.root, this.config.template)),
      }),
    };
  }

  private index(file: string): void {
    const slug = path.basename(file, ".md");
    const meta = frontmatter(readText(file));
    const title = typeof meta.title === "string" && meta.title.trim() ? meta.title : slug;
    const aliases = toStrings(meta.aliases);
    const summary = typeof meta.summary === "string" ? meta.summary : undefined;
    const url = this.config?.link?.replaceAll("{slug}", slug);
    this.notes.set(file, {
      slug,
      title,
      aliases,
      path: file,
      ...(summary && { summary }),
      ...(url && { url }),
    });
  }

  private rebuildKeys(): void {
    this.byKey.clear();
    for (const note of this.list()) {
      for (const name of [note.slug, note.title, ...note.aliases]) {
        const key = termKey(name);
        if (key && !this.byKey.has(key)) this.byKey.set(key, note);
      }
    }
  }
}

function walkMarkdown(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith(".") ? [] : walkMarkdown(full);
    return e.name.endsWith(".md") ? [full] : [];
  });
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  try {
    const data: unknown = parse(m[1]!);
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

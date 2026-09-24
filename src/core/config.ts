/**
 * Shape of `~/.zenspec/config.yaml` (plan §5, §11.1). Types only.
 * `ZENSPEC_HOME` overrides the `~/.zenspec` location (used by tests).
 * Paths may start with `~/`; the loader expands them.
 */

/** Folder of Markdown notes used to answer `explain` threads (§11). */
export interface KnowledgeBaseConfig {
  /** Root of the knowledge base, e.g. `~/Developer/projects/second-brain`. */
  root: string;
  /** Where new concept notes are written, relative to `root`. */
  notesDir: string;
  /** Note template, relative to `root`. */
  template?: string;
  /** URL pattern for a note; `{slug}` is replaced by the note's file slug. */
  link?: string;
}

export interface DaemonConfig {
  /** Fixed port; a free port is chosen when absent. */
  port?: number;
  /** Idle shutdown with no waiters and no browser tabs (default 30, §13). */
  idleMinutes?: number;
}

export interface ZenspecConfig {
  knowledgeBase?: KnowledgeBaseConfig;
  daemon?: DaemonConfig;
  /** Open the browser on the first `review` of a document (default true). */
  openBrowser?: boolean;
}

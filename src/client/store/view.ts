/** Pure view-model derivations: what the document view and the panels render. */
import type { KbNote } from "../../core/api.js";
import { diffHunks, diffLines, likelyAddressed } from "../../core/diff.js";
import type {
  Choice,
  Draft,
  DraftThread,
  LineRange,
  Question,
  QuestionId,
  Thread,
  ThreadKind,
  ThreadStatus,
} from "../../core/types.js";

export interface Highlight {
  threadId: string;
  lines: [number, number];
  status: ThreadStatus;
  kind: ThreadKind;
  active?: boolean;
}

export interface AnswerView {
  choice: Choice;
  note?: string;
  state: "draft" | "submitted";
}

function anchorLines(item: Thread | DraftThread): LineRange | undefined {
  if (item.placement) return item.placement.strategy === 6 ? undefined : item.placement.lines;
  if (item.kind === "general" || item.anchor.type !== "markdown") return undefined;
  return item.anchor.lines;
}

/** Unresolved threads and draft items with a place in the current text. */
export function highlightsFor(
  threads: readonly Thread[],
  draft: Draft | null,
  activeId?: string,
): Highlight[] {
  const out: Highlight[] = [];
  for (const t of threads) {
    const lines = t.status === "resolved" ? undefined : anchorLines(t);
    if (lines) out.push({ threadId: t.id, lines, status: t.status, kind: t.kind });
  }
  for (const d of draft?.threads ?? []) {
    const lines = d.orphaned ? undefined : anchorLines(d);
    if (lines) out.push({ threadId: d.draftId, lines, status: "open", kind: d.kind });
  }
  return out.map((h) => (h.threadId === activeId ? { ...h, active: true } : h));
}

/** Submitted decisions, overridden by the draft's answers (only answers the reviewer gave). */
export function answersFor(
  threads: readonly Thread[],
  draft: Draft | null,
  questions: readonly Question[],
): Record<QuestionId, AnswerView> {
  const known = new Set(questions.map((q) => q.id));
  const answers: Record<QuestionId, AnswerView> = {};
  for (const t of threads) {
    if (t.kind !== "decision" || t.status === "outdated") continue;
    const note = t.messages[0]?.body;
    answers[t.question] = { choice: t.choice, ...(note && { note }), state: "submitted" };
  }
  for (const d of draft?.threads ?? []) {
    if (d.kind !== "decision" || d.orphaned || !known.has(d.question)) continue;
    answers[d.question] = { choice: d.choice, ...(d.body && { note: d.body }), state: "draft" };
  }
  return answers;
}

/** A draft item is orphaned when re-anchoring failed or its question no longer exists (§9.1). */
export function isOrphaned(item: DraftThread, questions: readonly Question[] | null): boolean {
  if (item.orphaned) return true;
  return item.kind === "decision" && !!questions && !questions.some((q) => q.id === item.question);
}

/**
 * Changed lines of `newText`, in its numbering: inserted lines in a run that also deletes are
 * `modified`, the rest `added`.
 */
export function changedLines(oldText: string, newText: string) {
  const added: number[] = [];
  const modified: number[] = [];
  let run: { inserts: number[]; deletes: boolean } = { inserts: [], deletes: false };
  const flush = () => {
    (run.deletes ? modified : added).push(...run.inserts);
    run = { inserts: [], deletes: false };
  };
  for (const line of diffLines(oldText, newText)) {
    if (line.op === "equal") flush();
    else if (line.op === "delete") run.deletes = true;
    else run.inserts.push(line.newLine!);
  }
  flush();
  return { added, modified };
}

/**
 * "Likely addressed" hint (§4): the text the thread was anchored to at its capture revision
 * changed in the latest revision. Never changes the status.
 */
export function likelyAddressedHint(
  thread: Thread,
  latestN: number,
  texts: Record<number, string>,
): boolean {
  if (thread.status !== "open" || thread.kind === "general") return false;
  const anchor = thread.anchor;
  if (anchor.type !== "markdown" || anchor.rev >= latestN) return false;
  const before = texts[anchor.rev];
  const after = texts[latestN];
  if (before === undefined || after === undefined) return false;
  const placement = { revision: anchor.rev, strategy: 1 as const, lines: anchor.lines };
  return likelyAddressed(placement, diffHunks(before, after));
}

export function kbTermsFor(notes: readonly KbNote[]) {
  return notes.map((n) => ({
    term: n.title,
    aliases: n.aliases,
    summary: n.summary ?? "",
    link: n.url ?? `file://${n.path}`,
  }));
}

/** The knowledge-base note for an explain thread's term, by title or alias (§11). */
export function noteFor(term: string, notes: readonly KbNote[]): KbNote | undefined {
  const key = term.trim().toLowerCase();
  return notes.find(
    (n) =>
      n.title.toLowerCase() === key ||
      n.slug === key ||
      n.aliases.some((a) => a.toLowerCase() === key),
  );
}

/** A link written in an agent/daemon answer (`Title: https://…`), if any. */
export function linkIn(text: string): string | undefined {
  return /(https?:\/\/\S+|file:\/\/\S+)/.exec(text)?.[1];
}

export function describeChoice(choice: Choice): string {
  switch (choice.mode) {
    case "single":
      return choice.option;
    case "multi":
      return choice.options.join(", ");
    case "rating":
      return `${choice.value}`;
    case "other":
      return "Other";
  }
}

export function quoteOf(item: Thread | DraftThread): string {
  if (item.kind === "general") return "";
  if (item.kind === "decision") return "";
  return item.anchor.type === "markdown" ? item.anchor.quote : item.anchor.textQuote;
}

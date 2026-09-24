/**
 * Pure operations on the reviewer's pending review (plan §9, §9.1). Every reviewer action goes
 * through one of these, then the store saves the result to the daemon.
 */
import type { SubmitReviewRequest } from "../../core/api.js";
import type {
  AttachmentRef,
  Choice,
  Draft,
  DraftThread,
  MarkdownAnchor,
  Question,
  QuestionId,
  Thread,
  ThreadId,
  ThreadSpec,
  Verdict,
} from "../../core/types.js";

export function emptyDraft(revision: number): Draft {
  return {
    revision,
    summary: "",
    threads: [],
    reopen: [],
    resolve: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Short, since the document view may show it next to a highlight. Unique within a draft. */
export function newDraftId(taken: readonly DraftThread[] = []): string {
  for (;;) {
    const id = `d${Math.random().toString(36).slice(2, 6)}`;
    if (!taken.some((t) => t.draftId === id)) return id;
  }
}

export function isDraftEmpty(draft: Draft | null): boolean {
  return !draft || (!draft.threads.length && !draft.reopen.length && !draft.resolve.length);
}

export function addThread(
  draft: Draft,
  spec: ThreadSpec,
  body: string,
  attachments: AttachmentRef[] = [],
): Draft {
  const item = { ...spec, draftId: newDraftId(draft.threads), body, attachments } as DraftThread;
  return { ...draft, threads: [...draft.threads, item] };
}

export function updateThread(
  draft: Draft,
  draftId: string,
  patch: Partial<Pick<DraftThread, "body" | "attachments">> & { new?: string; term?: string },
): Draft {
  const threads = draft.threads.map((t) =>
    t.draftId === draftId ? ({ ...t, ...patch } as DraftThread) : t,
  );
  return { ...draft, threads };
}

export function removeThread(draft: Draft, draftId: string): Draft {
  return { ...draft, threads: draft.threads.filter((t) => t.draftId !== draftId) };
}

// ---------------------------------------------------------------------------
// Answers (§9.1): a decision exists only after the reviewer picks an option
// ---------------------------------------------------------------------------

export function questionAnchor(question: Question, revision: number): MarkdownAnchor {
  return {
    type: "markdown",
    rev: revision,
    block: question.block,
    quote: "",
    prefix: "",
    suffix: "",
    lines: question.lines,
  };
}

export function draftAnswer(draft: Draft | null, questionId: QuestionId) {
  return draft?.threads.find(
    (t): t is Extract<DraftThread, { kind: "decision" }> =>
      t.kind === "decision" && t.question === questionId,
  );
}

/** Sets, replaces, or (with `choice: null`) clears the draft answer to a question. */
export function setAnswer(
  draft: Draft,
  question: Question,
  choice: Choice | null,
  note = "",
): Draft {
  const existing = draftAnswer(draft, question.id);
  const rest = draft.threads.filter((t) => t !== existing);
  if (!choice) return { ...draft, threads: rest };
  const item: DraftThread = {
    kind: "decision",
    anchor: questionAnchor(question, draft.revision),
    question: question.id,
    choice,
    draftId: existing?.draftId ?? newDraftId(draft.threads),
    body: note,
    attachments: existing?.attachments ?? [],
  };
  const threads = existing
    ? draft.threads.map((t) => (t === existing ? item : t))
    : [...rest, item];
  return { ...draft, threads };
}

/** Questions with neither a draft answer nor a submitted decision. */
export function unansweredQuestions(
  questions: readonly Question[],
  draft: Draft | null,
  threads: readonly Thread[],
): Question[] {
  const submitted = new Set(threads.flatMap((t) => (t.kind === "decision" ? [t.question] : [])));
  return questions.filter((q) => !submitted.has(q.id) && !draftAnswer(draft, q.id));
}

export function recommendedChoice(question: Question): Choice | null {
  const rec = question.recommended;
  if (rec === undefined) return null;
  if (question.mode === "multi") return { mode: "multi", options: [rec] };
  if (question.mode === "rating") {
    const value = Number(rec);
    return Number.isFinite(value) ? { mode: "rating", value } : null;
  }
  return { mode: "single", option: rec };
}

/** Only on the reviewer's explicit request at submit time (§9.1). */
export function acceptRecommended(draft: Draft, questions: readonly Question[]): Draft {
  return questions.reduce((d, q) => {
    const choice = recommendedChoice(q);
    return choice ? setAnswer(d, q, choice) : d;
  }, draft);
}

// ---------------------------------------------------------------------------
// Thread actions: staged in the draft, applied by `review_submitted`
// ---------------------------------------------------------------------------

function unstaged(draft: Draft, id: ThreadId): Draft {
  return {
    ...draft,
    reopen: draft.reopen.filter((r) => r.thread !== id),
    resolve: draft.resolve.filter((t) => t !== id),
  };
}

export function stageResolve(draft: Draft, id: ThreadId): Draft {
  const next = unstaged(draft, id);
  return { ...next, resolve: [...next.resolve, id] };
}

/** Reopen, or reply to an addressed/declined/outdated thread (a reply reopens it). */
export function stageReopen(
  draft: Draft,
  id: ThreadId,
  body: string,
  attachments: AttachmentRef[] = [],
): Draft {
  const next = unstaged(draft, id);
  return { ...next, reopen: [...next.reopen, { thread: id, body, attachments }] };
}

export function unstage(draft: Draft, id: ThreadId): Draft {
  return unstaged(draft, id);
}

export function stagedAction(draft: Draft | null, id: ThreadId): "resolve" | "reopen" | null {
  if (draft?.resolve.includes(id)) return "resolve";
  if (draft?.reopen.some((r) => r.thread === id)) return "reopen";
  return null;
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export function toSubmitRequest(
  draft: Draft | null,
  revision: number,
  verdict: Verdict,
  summary: string,
): SubmitReviewRequest {
  const d = draft ?? emptyDraft(revision);
  return {
    revision,
    verdict,
    summary,
    // Orphaned items are still sent: the agent gets their original quote.
    opened: d.threads.map(({ draftId: _id, orphaned: _o, placement: _p, ...thread }) => thread),
    reopened: d.reopen.map((r) => ({ id: r.thread, body: r.body, attachments: r.attachments })),
    resolved: [...d.resolve],
  };
}

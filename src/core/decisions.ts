/**
 * Decision records (plan §4 `decision` threads): what the reviewer chose for each `[!QUESTION]`,
 * joined with the question as the parser sees it. Shared by the ADR and the HTML export.
 */
import { latestReview } from "./reducer.js";
import type { DocState, Message, ParsedDocument, Question, Thread } from "./types.js";

export type DecisionThread = Extract<Thread, { kind: "decision" }>;

export interface DecisionRecord {
  thread: DecisionThread;
  /** The question in the parsed document; absent when it no longer exists. */
  question?: Question;
  title: string;
  /** Every option of the question, in document order (empty for ratings). */
  options: string[];
  /** Option labels the reviewer picked (empty for ratings and write-ins). */
  chosen: string[];
  /** The choice as one line: `PostgreSQL`, `auth, billing`, `4`, or the write-in text. */
  outcome: string;
  /** The reviewer's note on the choice (empty for write-ins, whose text is the outcome). */
  note: string;
  /** Every message after the opening one: agent responses, replies, reopen and resolve. */
  discussion: Message[];
}

/**
 * One record per question, in document order where the question still exists. When a question
 * was answered more than once, the latest decision thread wins.
 */
export function decisionRecords(state: DocState, doc: ParsedDocument): DecisionRecord[] {
  const latest = new Map<string, DecisionThread>();
  for (const id of state.threadOrder) {
    const thread = state.threads[id];
    if (thread?.kind === "decision") {
      latest.delete(thread.question);
      latest.set(thread.question, thread);
    }
  }
  const order = new Map(doc.questions.map((q, i) => [q.id, i]));
  const rank = (t: DecisionThread) => order.get(t.question) ?? order.size;
  return [...latest.values()]
    .sort((a, b) => rank(a) - rank(b))
    .map((thread) =>
      toRecord(
        thread,
        doc.questions.find((q) => q.id === thread.question),
      ),
    );
}

function toRecord(thread: DecisionThread, question: Question | undefined): DecisionRecord {
  const [opening, ...discussion] = thread.messages;
  const body = opening?.body.trim() ?? "";
  const { choice } = thread;
  let chosen: string[] = [];
  let outcome: string;
  let note = body;
  switch (choice.mode) {
    case "single":
      chosen = [choice.option];
      outcome = choice.option;
      break;
    case "multi":
      chosen = choice.options;
      outcome = choice.options.join(", ");
      break;
    case "rating":
      outcome = String(choice.value);
      break;
    case "other":
      outcome = body || "other";
      note = "";
      break;
  }
  return {
    thread,
    question,
    title: question?.title ?? thread.question,
    options: question?.options ?? [],
    chosen,
    outcome,
    note,
    discussion,
  };
}

/** Frontmatter `title`, else the first level-1 heading, else the file name without extension. */
export function documentTitle(
  doc: Pick<ParsedDocument, "frontmatter" | "blocks">,
  relPath: string,
): string {
  const title = doc.frontmatter?.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  const h1 = doc.blocks.find((b) => b.type === "heading" && /^#\s/.test(b.source));
  if (h1)
    return h1.source
      .slice(1)
      .replace(/\s#*\s*$/, "")
      .trim();
  const base = relPath.split("/").at(-1) ?? relPath;
  return base.replace(/\.[^.]+$/, "");
}

/** `YYYY-MM-DD` of the latest approving review, else of the latest review or revision. */
export function decisionDate(state: DocState): string | undefined {
  const approval = state.reviews.findLast((r) => r.verdict === "approved");
  const ts = approval?.ts ?? latestReview(state)?.ts ?? state.revisions.at(-1)?.ts;
  return ts?.slice(0, 10);
}

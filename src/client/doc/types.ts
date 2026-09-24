import type {
  Choice,
  LineRange,
  QuestionId,
  StepId,
  ThreadKind,
  ThreadStatus,
} from "../../core/types.js";

/** Toolbar action chosen for a selection. HTML mockups only offer `comment` and `explain` (§12). */
export type SelectAction = "comment" | "suggest" | "explain";

/** A text selection inside one Markdown block. `start`/`end` are offsets into `source`. */
export interface MarkdownSelection {
  blockId: string;
  quote: string;
  start: number;
  end: number;
  lines: LineRange;
  action: SelectAction;
}

/** An element picked inside an HTML mockup. */
export interface HtmlSelection {
  html: { cssPath: string; tag: string; textQuote: string };
  action: SelectAction;
}

export type DocumentSelection = MarkdownSelection | HtmlSelection;

export interface DocHighlight {
  threadId: string;
  lines: LineRange;
  status: ThreadStatus;
  kind: ThreadKind;
  active?: boolean;
  /** HTML mockups: element the thread is anchored to (best effort). */
  cssPath?: string;
}

export interface AnswerState {
  choice: Choice;
  note?: string;
  state: "draft" | "submitted";
}

export interface StepState {
  checked: boolean;
  checkedAt?: string;
}

export interface KbTerm {
  term: string;
  aliases: string[];
  summary: string;
  link: string;
}

export interface DocFocus {
  threadId?: string;
  lines?: LineRange;
  nonce: number;
}

export interface DocumentViewProps {
  kind: "markdown" | "html";
  /** Markdown text, or HTML text for mockups. */
  source: string;
  highlights: DocHighlight[];
  /** Unpublished-changes or revision-diff marks, as new-side line numbers. */
  diffLines?: { added: number[]; modified: number[] };
  answers: Record<QuestionId, AnswerState>;
  steps?: Record<StepId, StepState>;
  kbTerms?: KbTerm[];
  /** Scroll to and pulse a thread or a line range; bump `nonce` to repeat. */
  focus?: DocFocus;
  onSelect(sel: DocumentSelection): void;
  onAnswer(questionId: QuestionId, choice: Choice | null, note?: string): void;
  onHighlightClick(threadId: string): void;
}

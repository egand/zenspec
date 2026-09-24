/** Document view of the browser client: renders a Markdown plan or an HTML mockup for review. */
import "katex/dist/katex.min.css";
import "../styles/doc.css";

export { DocumentView } from "./DocumentView.js";
export type {
  AnswerState,
  DocFocus,
  DocHighlight,
  DocumentSelection,
  DocumentViewProps,
  HtmlSelection,
  KbTerm,
  MarkdownSelection,
  SelectAction,
  StepState,
} from "./types.js";

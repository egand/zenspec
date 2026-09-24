import type { JSX } from "preact";
import { HtmlView } from "./html/HtmlView.js";
import { MarkdownView } from "./MarkdownView.js";
import type { DocumentViewProps } from "./types.js";

export function DocumentView(props: DocumentViewProps): JSX.Element {
  return props.kind === "html" ? <HtmlView {...props} /> : <MarkdownView {...props} />;
}

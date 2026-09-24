import type { Blockquote, List, ListItem, RootContent } from "mdast";
import { toString } from "mdast-util-to-string";
import type { QuestionMode } from "../types.js";

/** A question callout before IDs and positions are assigned. */
export interface QuestionCallout {
  mode: QuestionMode;
  title: string;
  /** Explicit `{#id}` override, if written. */
  explicitId?: string;
  options: string[];
  recommended?: string;
  /** The list holding the options: its task items are answers, not plan steps. */
  optionList?: List;
}

const MARKER = /^\s*\[!QUESTION(?::([\w-]+))?\]/i;
const ID_OVERRIDE = /\s*\{#([\w-]+)\}\s*$/;
const RECOMMENDED = /\s*\(recommended\)/i;

function modeOf(tag: string | undefined): QuestionMode {
  switch (tag?.toLowerCase()) {
    case "multi":
    case "checkbox":
      return "multi";
    case "rating":
    case "scale":
      return "rating";
    default:
      return "single";
  }
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function optionLabel(item: ListItem): string {
  const lead = item.children.find((child) => child.type === "paragraph") ?? item;
  return toString(lead).replace(RECOMMENDED, "").replace(/\s+/g, " ").trim();
}

/**
 * Recognizes `> [!QUESTION]`, `> [!QUESTION:MULTI]` and `> [!QUESTION:RATING]` callouts.
 * The title sits on the marker line or comes from the first heading/paragraph inside.
 * `(Recommended)` marks the recommended option; failing that, a single `[x]` item does.
 * Nothing is ever reported as selected (§9.1).
 */
export function readQuestion(node: Blockquote): QuestionCallout | null {
  const [head, ...rest] = node.children;
  if (head?.type !== "paragraph") return null;
  const headText = toString(head);
  const marker = MARKER.exec(headText);
  if (!marker) return null;

  let title = firstLine(headText.slice(marker[0].length));
  const body: RootContent[] = rest;
  if (!title) {
    const titleNode = body.find((child) => child.type === "heading" || child.type === "paragraph");
    if (titleNode) title = firstLine(toString(titleNode));
  }

  const override = ID_OVERRIDE.exec(title);
  if (override) title = title.slice(0, override.index).trim();

  const optionList = body.find((child): child is List => child.type === "list");
  const items = optionList?.children ?? [];
  const options = items.map(optionLabel);
  const flagged = items.findIndex((item) => RECOMMENDED.test(toString(item)));
  const ticked = items.filter((item) => item.checked === true);
  const recommendedIndex =
    flagged >= 0 ? flagged : ticked.length === 1 ? items.indexOf(ticked[0]!) : -1;

  return {
    mode: modeOf(marker[1]),
    title: title || "Question",
    explicitId: override?.[1],
    options,
    recommended: recommendedIndex >= 0 ? options[recommendedIndex] : undefined,
    optionList,
  };
}

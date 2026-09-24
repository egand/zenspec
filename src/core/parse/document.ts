import type { List, Nodes, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";
import type { ParsedBlock, ParsedMarkdown, Question, Step, StepId } from "../types.js";
import { readQuestion } from "./question.js";
import { Slugger, slugify } from "./slug.js";

/** Parse result plus the source offset of each step's checkbox character (`[ ]` / `[x]`). */
export interface Analysis {
  doc: ParsedMarkdown;
  checkboxOffsets: Map<StepId, number>;
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkFrontmatter, ["yaml"]);

/** Section slug for content above the first heading. Reserved so a heading can't claim it. */
const TOP_SECTION = "top";
const FRONTMATTER_BLOCK = "frontmatter";
const STEP_SLUG_MAX = 48;
const TASK_MARKER = /^(?:[*+-]|\d+[.)])[ \t]+\[[ xX]\]/;

const BLOCK_PREFIX: Record<string, string> = {
  paragraph: "p",
  list: "l",
  code: "c",
  blockquote: "b",
  table: "t",
  math: "m",
  html: "x",
  thematicBreak: "hr",
  definition: "d",
  footnoteDefinition: "fn",
};

function lineRange(node: Nodes): [number, number] {
  return [node.position!.start.line, node.position!.end.line];
}

function readFrontmatter(value: string): Record<string, unknown> | undefined {
  try {
    const data: unknown = parseYaml(value);
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stepSlug(text: string): string {
  const slug = slugify(text, "step");
  if (slug.length <= STEP_SLUG_MAX) return slug;
  const cut = slug.slice(0, STEP_SLUG_MAX);
  const dash = cut.lastIndexOf("-");
  return dash > 0 ? cut.slice(0, dash) : cut;
}

/**
 * Block IDs: `<section>/<prefix><n>`, where `<section>` is the deduplicated slug of the nearest
 * heading (`top` above the first one) and `<n>` counts blocks of the same kind in that section.
 * Headings take their section slug as ID. Question callouts use prefix `q`.
 * Step IDs: `<section>/<slug of the item text>`, independent of the checked state.
 */
export function analyze(markdown: string): Analysis {
  const root = processor.parse(markdown) as Root;
  const sections = new Slugger([TOP_SECTION, FRONTMATTER_BLOCK]);
  const stepIds = new Slugger();
  const questionIds = new Slugger();

  const blocks: ParsedBlock[] = [];
  const questions: Question[] = [];
  const steps: Step[] = [];
  const checkboxOffsets = new Map<StepId, number>();
  let frontmatter: Record<string, unknown> | undefined;

  let section = TOP_SECTION;
  let counters = new Map<string, number>();
  const headingPath: { depth: number; text: string }[] = [];

  const collectSteps = (node: Nodes, skip: List | undefined): void => {
    if (node === skip || !("children" in node)) return;
    for (const child of node.children) {
      if (child.type === "listItem" && typeof child.checked === "boolean") {
        const lead = child.children.find((c) => c.type === "paragraph");
        const text = (lead ? toString(lead) : "").replace(/\s+/g, " ").trim();
        const id = stepIds.unique(`${section}/${stepSlug(text)}`);
        const start = child.position!.start.offset!;
        const marker = TASK_MARKER.exec(markdown.slice(start));
        if (marker) checkboxOffsets.set(id, start + marker[0].length - 2);
        steps.push({
          id,
          text,
          checked: child.checked,
          line: child.position!.start.line,
          section: headingPath.map((h) => h.text),
        });
      }
      collectSteps(child, skip);
    }
  };

  for (const node of root.children) {
    const lines = lineRange(node);
    const source = markdown.slice(node.position!.start.offset, node.position!.end.offset);
    const push = (id: string): void => {
      blocks.push({ id, type: node.type, lines, source, node });
    };
    const nextId = (prefix: string): string => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${section}/${prefix}${n}`;
    };

    if (node.type === "yaml") {
      frontmatter = readFrontmatter(node.value);
      push(FRONTMATTER_BLOCK);
      continue;
    }

    if (node.type === "heading") {
      const text = toString(node).trim();
      while (headingPath.length && headingPath.at(-1)!.depth >= node.depth) headingPath.pop();
      headingPath.push({ depth: node.depth, text });
      section = sections.unique(slugify(text, "section"));
      counters = new Map();
      push(section);
      continue;
    }

    const callout = node.type === "blockquote" ? readQuestion(node) : null;
    if (callout) {
      const id = nextId("q");
      push(id);
      questions.push({
        id: questionIds.unique(callout.explicitId ?? slugify(callout.title, "question")),
        mode: callout.mode,
        title: callout.title,
        block: id,
        lines,
        options: callout.options,
        recommended: callout.recommended,
      });
      collectSteps(node, callout.optionList);
      continue;
    }

    push(nextId(BLOCK_PREFIX[node.type] ?? node.type));
    collectSteps(node, undefined);
  }

  return { doc: { frontmatter, blocks, questions, steps }, checkboxOffsets };
}

/** Parses a Markdown document into blocks, questions, steps and frontmatter (§6). */
export function parseDocument(markdown: string): ParsedMarkdown {
  return analyze(markdown).doc;
}

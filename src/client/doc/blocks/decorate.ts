/** Splits document-wide inputs (answers, steps, KB terms, link definitions) into per-block decorations. */
import type { Nodes } from "mdast";
import type { ParsedMarkdown, StepId } from "../../../core/types.js";
import { assignTerms } from "../kb/terms.js";
import type { BlockStep, Definitions } from "../render/markdown.js";
import type { AnswerState, KbTerm, StepState } from "../types.js";
import type { BlockDeco } from "./Block.js";

function hasReference(node: Nodes): boolean {
  if (node.type === "linkReference" || node.type === "imageReference") return true;
  return "children" in node && node.children.some(hasReference);
}

export interface DecorateInput {
  answers: Record<string, AnswerState>;
  steps?: Record<StepId, StepState>;
  terms: KbTerm[];
}

/** Effective checked state: the reducer's view when known, else the file's checkbox. */
export const stepChecked = (
  step: { id: StepId; checked: boolean },
  steps?: Record<StepId, StepState>,
): boolean => steps?.[step.id]?.checked ?? step.checked;

export function decorate(doc: ParsedMarkdown, input: DecorateInput): Map<string, BlockDeco> {
  const questions = new Map(doc.questions.map((q) => [q.block, q]));
  const skip = new Set([...questions.keys(), "frontmatter"]);
  const terms = assignTerms(doc.blocks, input.terms, skip);
  const current = doc.steps.find((s) => !stepChecked(s, input.steps))?.id;

  const definitions: Definitions = {};
  for (const block of doc.blocks) {
    if (block.node.type === "definition") {
      definitions[block.node.identifier] = { url: block.node.url, title: block.node.title };
    }
  }

  const decos = new Map<string, BlockDeco>();
  for (const block of doc.blocks) {
    const [from, to] = block.lines;
    const steps: BlockStep[] = doc.steps
      .filter((s) => s.line >= from && s.line <= to)
      .map((s) => ({
        id: s.id,
        checked: stepChecked(s, input.steps),
        checkedAt: input.steps?.[s.id]?.checkedAt,
        current: s.id === current,
      }));
    const question = questions.get(block.id);
    const deco: BlockDeco = { terms: terms.get(block.id) ?? [], steps };
    if (question) {
      const { id, mode, title, options, recommended } = question;
      deco.question = { id, mode, title, options, recommended };
      deco.answer = input.answers[question.id];
    }
    if (hasReference(block.node)) deco.definitions = definitions;
    decos.set(block.id, deco);
  }
  return decos;
}

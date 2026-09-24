/** Word-level diff for the suggestion preview, reusing the core line diff on word tokens. */
import { diffLines } from "../../core/diff.js";

export interface WordChange {
  op: "equal" | "delete" | "insert";
  text: string;
}

const NL = "\u0000";
const tokens = (text: string) => text.split(/(\s+)/).filter(Boolean);
// One token per "line"; newlines inside whitespace tokens are escaped so they stay one token.
const asLines = (words: string[]) => words.map((w) => w.replaceAll("\n", NL)).join("\n");

export function wordDiff(oldText: string, newText: string): WordChange[] {
  const out: WordChange[] = [];
  for (const line of diffLines(asLines(tokens(oldText)), asLines(tokens(newText)))) {
    const text = line.text.replaceAll(NL, "\n");
    const last = out.at(-1);
    if (last?.op === line.op) last.text += text;
    else out.push({ op: line.op, text });
  }
  return out;
}

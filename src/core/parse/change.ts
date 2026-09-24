import type { DocumentChange } from "../types.js";
import { analyze, type Analysis } from "./document.js";

/** The source with every step checkbox blanked, so checking a step leaves it unchanged. */
function withoutCheckmarks(source: string, { checkboxOffsets }: Analysis): string {
  let out = source;
  for (const offset of checkboxOffsets.values()) {
    out = `${out.slice(0, offset)} ${out.slice(offset + 1)}`;
  }
  return out;
}

export function classifyChange(before: string, after: string): DocumentChange {
  if (before === after) return { kind: "none" };
  const old = analyze(before);
  const next = analyze(after);
  if (withoutCheckmarks(before, old) !== withoutCheckmarks(after, next)) return { kind: "content" };

  const was = new Map(old.doc.steps.map((s) => [s.id, s.checked]));
  const steps = next.doc.steps
    .filter((s) => was.get(s.id) !== s.checked)
    .map((s) => ({ step: s.id, checked: s.checked }));
  return steps.length ? { kind: "checkbox-only", steps } : { kind: "content" };
}

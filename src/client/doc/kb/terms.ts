/**
 * Knowledge-base tooltips (§11.2): the first occurrence of each known term in a document gets
 * an underline. This module decides which block holds that first occurrence.
 */
import type { Nodes } from "mdast";
import type { ParsedBlock } from "../../../core/types.js";
import type { KbTerm } from "../types.js";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive, whole-word pattern for a term and its aliases (longest first). */
export function termPattern(term: KbTerm): RegExp {
  const names = [term.term, ...term.aliases].filter(Boolean).sort((a, b) => b.length - a.length);
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${names.map(escape).join("|")})(?![\\p{L}\\p{N}_])`,
    "iu",
  );
}

/** Plain prose of a node: text leaves outside code, math, and raw HTML. */
function prose(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "link" || node.type === "linkReference") return "";
  if (!("children" in node)) return "";
  return node.children.map((child) => prose(child)).join(" ");
}

/**
 * Maps block ID → terms whose first document occurrence lies in that block.
 * Blocks in `skip` (frontmatter, question cards) never receive a term.
 */
export function assignTerms(
  blocks: readonly ParsedBlock[],
  terms: readonly KbTerm[],
  skip: ReadonlySet<string> = new Set(),
): Map<string, KbTerm[]> {
  const assigned = new Map<string, KbTerm[]>();
  const texts = blocks.filter((b) => !skip.has(b.id)).map((b) => [b.id, prose(b.node)] as const);
  for (const term of terms) {
    const pattern = termPattern(term);
    const hit = texts.find(([, text]) => pattern.test(text));
    if (hit) assigned.set(hit[0], [...(assigned.get(hit[0]) ?? []), term]);
  }
  return assigned;
}

const DISMISSED_KEY = "zen-kb-dismissed";

/** Terms the viewer dismissed with "Got it". Per-viewer; storage may be unavailable. */
export function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveDismissed(terms: ReadonlySet<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...terms]));
  } catch {
    // Private mode or blocked storage: dismissal lasts for this page only.
  }
}

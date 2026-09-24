/**
 * Cheap, deterministic token estimate used by the cost-budget tests (plan §3).
 *
 * Heuristic: the larger of two lower bounds, rounded up.
 * - `chars / 3.5`: BPE tokenizers average ~4 characters per token on English prose and
 *   fewer on code, paths, and hashes; 3.5 leans conservative.
 * - `pieces`: every run of letters/digits and every standalone symbol (`-`, `:`, `/`, `#`)
 *   is at least one token. This dominates on punctuation-heavy text such as YAML keys.
 *
 * It over-counts slightly compared with real tokenizers, which is the safe direction for
 * a budget check. Not meant for billing.
 */
const PIECE = /[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const chars = [...text].length;
  const pieces = text.match(PIECE)?.length ?? 0;
  return Math.ceil(Math.max(chars / 3.5, pieces));
}

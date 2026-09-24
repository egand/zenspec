/**
 * Approximate substring search for re-anchoring (plan §7, strategy 4).
 *
 * Text and pattern are whitespace-normalized first (every run of whitespace becomes a
 * single space), then Sellers' algorithm finds the substring of the text with the smallest
 * Levenshtein distance to the pattern in O(pattern × text) time and O(pattern) memory.
 * Similarity is `1 - distance / max(pattern length, match length)`.
 */

/** Whitespace-normalized text plus a map from each normalized index to its original index. */
export interface NormalizedText {
  text: string;
  origin: number[];
}

export interface FuzzyMatch {
  /** Offsets into the original (non-normalized) text, end exclusive. */
  start: number;
  end: number;
  score: number;
}

export function normalizeWhitespace(text: string): NormalizedText {
  let out = "";
  const origin: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const isSpace = /\s/.test(text[i]!);
    if (isSpace && inSpace) continue;
    inSpace = isSpace;
    out += isSpace ? " " : text[i];
    origin.push(i);
  }
  return { text: out, origin };
}

/**
 * Best approximate occurrence of `pattern` in `text[from, to)` with similarity ≥ `threshold`.
 * With `unique`, returns null when the best distance is reached at two non-overlapping places.
 */
export function fuzzyFind(
  text: string,
  pattern: string,
  options: { from?: number; to?: number; threshold: number; unique?: boolean },
): FuzzyMatch | null {
  const from = options.from ?? 0;
  const to = options.to ?? text.length;
  const hay = normalizeWhitespace(text.slice(from, to));
  const needle = normalizeWhitespace(pattern).text.trim();
  const m = needle.length;
  if (m === 0 || hay.text.length === 0) return null;

  const maxDist = Math.floor(m * (1 - options.threshold));
  const ends = bestEnds(hay.text, needle);
  if (ends.dist > maxDist) return null;
  if (options.unique && ends.positions.at(-1)! - ends.positions[0]! >= m) return null;

  // Adjacent ends tie for the same match ("TTL ", "TTL p", ..., "TTL plus" against
  // "TTL only"): keep the one whose match length is closest to the pattern's.
  let start = 0;
  let end = 0;
  for (const position of ends.positions) {
    if (position - ends.positions[0]! >= m) break;
    const length = matchLength(hay.text, needle, position + 1, ends.dist);
    if (end === 0 || Math.abs(length - m) < Math.abs(end - start - m)) {
      [start, end] = [position + 1 - length, position + 1];
    }
  }
  const score = 1 - ends.dist / Math.max(m, end - start);
  if (score < options.threshold) return null;
  return {
    start: from + hay.origin[start]!,
    end: from + hay.origin[end - 1]! + 1,
    score,
  };
}

/** Sellers: minimal edit distance of `p` against any substring of `t`, and where such substrings end. */
function bestEnds(t: string, p: string): { dist: number; positions: number[] } {
  const m = p.length;
  const col = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) col[i] = i;
  let dist = m;
  let positions: number[] = [];
  for (let j = 0; j < t.length; j++) {
    let diag = 0; // col[0] stays 0: a match may start anywhere
    const c = t.charCodeAt(j);
    for (let i = 1; i <= m; i++) {
      const up = col[i]!;
      col[i] = Math.min(up + 1, col[i - 1]! + 1, diag + (p.charCodeAt(i - 1) === c ? 0 : 1));
      diag = up;
    }
    if (col[m]! < dist) {
      dist = col[m]!;
      positions = [j];
    } else if (col[m] === dist) {
      positions.push(j);
    }
  }
  return { dist, positions };
}

/**
 * Length of the substring ending at `end` that matches `p` with `dist` edits:
 * edit distance of reversed `p` against prefixes of the reversed text before `end`.
 */
function matchLength(t: string, p: string, end: number, dist: number): number {
  const m = p.length;
  const width = Math.min(end, m + dist);
  let prev = new Int32Array(width + 1);
  let cur = new Int32Array(width + 1);
  for (let j = 0; j <= width; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const c = p.charCodeAt(m - i);
    for (let j = 1; j <= width; j++) {
      const same = t.charCodeAt(end - j) === c ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + same);
    }
    [prev, cur] = [cur, prev];
  }
  // Among lengths reaching the minimal distance, prefer the one closest to the pattern's.
  let best = 0;
  for (let j = 1; j <= width; j++) {
    if (
      prev[j]! < prev[best]! ||
      (prev[j] === prev[best] && Math.abs(j - m) < Math.abs(best - m))
    ) {
      best = j;
    }
  }
  return best;
}

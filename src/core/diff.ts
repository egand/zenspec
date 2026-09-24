/**
 * Line diff between two revisions (plan §9 revision timeline) and the "likely addressed"
 * hint (§4). Myers' O((N+M)·D) algorithm in linear space: the middle-snake bisection
 * recurses on both halves, so memory stays O(N+M) even for unrelated documents.
 */
import type { Placement } from "./types.js";

export type DiffOp = "equal" | "delete" | "insert";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line in the old revision (equal and delete lines). */
  oldLine?: number;
  /** 1-based line in the new revision (equal and insert lines). */
  newLine?: number;
}

/**
 * A run of changes with surrounding context. `oldStart`/`newStart` are the first line of the
 * hunk in each revision; with a zero count, the hunk sits just before that line.
 */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Splits text into lines; a trailing newline does not produce an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Every line of both revisions, in order, tagged with how it changed. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ids = new Map<string, number>();
  const intern = (lines: string[]) =>
    Int32Array.from(lines, (line) => {
      let id = ids.get(line);
      if (id === undefined) ids.set(line, (id = ids.size));
      return id;
    });
  const ops = myers(intern(a), intern(b));

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "equal") out.push({ op, text: a[i]!, oldLine: ++i, newLine: ++j });
    else if (op === "delete") out.push({ op, text: a[i]!, oldLine: ++i });
    else out.push({ op, text: b[j]!, newLine: ++j });
  }
  return out;
}

/** Changes grouped into hunks with `context` unchanged lines around them (like `diff -u`). */
export function diffHunks(oldText: string, newText: string, context = 3): Hunk[] {
  const lines = diffLines(oldText, newText);
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.op === "equal") {
      i++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    for (let j = i; j < lines.length;) {
      if (lines[j]!.op !== "equal") {
        end = ++j;
        continue;
      }
      let k = j;
      while (k < lines.length && lines[k]!.op === "equal") k++;
      if (k === lines.length || k - j > 2 * context) break;
      j = k;
    }
    const stop = Math.min(lines.length, end + context);
    hunks.push(toHunk(lines, start, stop));
    i = stop;
  }
  return hunks;
}

function toHunk(all: DiffLine[], start: number, stop: number): Hunk {
  const lines = all.slice(start, stop);
  // Line numbers where the hunk begins: the first numbered line at or after `start`,
  // or one past the last line before it.
  const firstAt = (key: "oldLine" | "newLine") => {
    for (let i = start; i < all.length; i++) if (all[i]![key] !== undefined) return all[i]![key]!;
    for (let i = start - 1; i >= 0; i--) if (all[i]![key] !== undefined) return all[i]![key]! + 1;
    return 1;
  };
  return {
    oldStart: firstAt("oldLine"),
    oldLines: lines.filter((l) => l.op !== "insert").length,
    newStart: firstAt("newLine"),
    newLines: lines.filter((l) => l.op !== "delete").length,
    lines,
  };
}

/**
 * UI hint (§4): did the diff from the placement's revision touch the anchored lines?
 * Deleted or replaced lines inside the range count, as do lines inserted between two of
 * its lines; insertions just above or below it do not. Never changes a thread's status.
 */
export function likelyAddressed(placement: Placement, hunks: readonly Hunk[]): boolean {
  if (!placement.lines) return false;
  const [first, last] = placement.lines;
  for (const hunk of hunks) {
    let old = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.op === "insert") {
        if (first < old && old <= last) return true;
      } else {
        if (line.op === "delete" && first <= old && old <= last) return true;
        old++;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Myers, linear space (after Neil Fraser's diff-match-patch bisection)
// ---------------------------------------------------------------------------

function myers(a: Int32Array, b: Int32Array): DiffOp[] {
  const ops: DiffOp[] = [];
  const push = (op: DiffOp, count: number) => {
    for (let n = 0; n < count; n++) ops.push(op);
  };

  const solve = (aLo: number, aHi: number, bLo: number, bHi: number): void => {
    let prefix = 0;
    while (aLo + prefix < aHi && bLo + prefix < bHi && a[aLo + prefix] === b[bLo + prefix])
      prefix++;
    push("equal", prefix);
    aLo += prefix;
    bLo += prefix;
    let suffix = 0;
    while (
      aHi - suffix > aLo &&
      bHi - suffix > bLo &&
      a[aHi - suffix - 1] === b[bHi - suffix - 1]
    ) {
      suffix++;
    }
    aHi -= suffix;
    bHi -= suffix;

    if (aLo === aHi) push("insert", bHi - bLo);
    else if (bLo === bHi) push("delete", aHi - aLo);
    else {
      const split = bisect(a, b, aLo, aHi, bLo, bHi);
      if (split) {
        solve(aLo, split[0], bLo, split[1]);
        solve(split[0], aHi, split[1], bHi);
      } else {
        push("delete", aHi - aLo);
        push("insert", bHi - bLo);
      }
    }
    push("equal", suffix);
  };

  solve(0, a.length, 0, b.length);
  return ops;
}

/** Finds a point on an optimal edit path where the forward and backward searches meet. */
function bisect(
  a: Int32Array,
  b: Int32Array,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
): [number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  const size = 2 * maxD + 2;
  const vf = new Int32Array(size).fill(-1);
  const vb = new Int32Array(size).fill(-1);
  vf[offset + 1] = 0;
  vb[offset + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let fStart = 0;
  let fEnd = 0;
  let bStart = 0;
  let bEnd = 0;

  for (let d = 0; d < maxD; d++) {
    for (let k = -d + fStart; k <= d - fEnd; k += 2) {
      const i = offset + k;
      let x = k === -d || (k !== d && vf[i - 1]! < vf[i + 1]!) ? vf[i + 1]! : vf[i - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      vf[i] = x;
      if (x > n) fEnd += 2;
      else if (y > m) fStart += 2;
      else if (front) {
        const j = offset + delta - k;
        if (j >= 0 && j < size && vb[j] !== -1 && x >= n - vb[j]!) return [aLo + x, bLo + y];
      }
    }
    for (let k = -d + bStart; k <= d - bEnd; k += 2) {
      const i = offset + k;
      let x = k === -d || (k !== d && vb[i - 1]! < vb[i + 1]!) ? vb[i + 1]! : vb[i - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aHi - x - 1] === b[bHi - y - 1]) {
        x++;
        y++;
      }
      vb[i] = x;
      if (x > n) bEnd += 2;
      else if (y > m) bStart += 2;
      else if (!front) {
        const j = offset + delta - k;
        if (j >= 0 && j < size && vf[j] !== -1 && vf[j]! >= n - x) {
          return [aLo + vf[j]!, bLo + vf[j]! - (j - offset)];
        }
      }
    }
  }
  return null;
}

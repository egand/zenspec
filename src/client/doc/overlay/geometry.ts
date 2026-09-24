/**
 * Maps source line ranges to rendered elements and to rectangles, for the decoration overlay
 * (thread highlights, diff marks, focus pulse). Decorations never touch block rendering.
 */
import type { LineRange } from "../../../core/types.js";

export interface Band {
  top: number;
  left: number;
  width: number;
  height: number;
}

const overlaps = (a: LineRange, b: LineRange): boolean => a[0] <= b[1] && b[0] <= a[1];

/**
 * The most specific elements covering `range`: whole blocks when fully covered, otherwise the
 * innermost list items, table rows or code lines inside them (via `data-rl-*` relative lines).
 */
export function elementsForLines(body: HTMLElement, range: LineRange): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const block of body.querySelectorAll<HTMLElement>("[data-block-id]")) {
    const start = Number(block.dataset.lineStart);
    const end = Number(block.dataset.lineEnd);
    if (!overlaps([start, end], range)) continue;
    if (range[0] <= start && end <= range[1]) {
      found.push(block);
      continue;
    }
    const inner = [...block.querySelectorAll<HTMLElement>("[data-rl-start]")].filter((el) =>
      overlaps([start + Number(el.dataset.rlStart), start + Number(el.dataset.rlEnd)], range),
    );
    const innermost = inner.filter(
      (el) => !inner.some((other) => other !== el && el.contains(other)),
    );
    found.push(...(innermost.length ? innermost : [block]));
  }
  return found;
}

/** Union rectangle of `els`, relative to `body`. */
export function bandOf(body: HTMLElement, els: readonly Element[]): Band | null {
  if (!els.length) return null;
  const origin = body.getBoundingClientRect();
  const rects = els.map((el) => el.getBoundingClientRect());
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.right));
  return {
    top: top - origin.top,
    left: left - origin.left,
    width: right - left,
    height: bottom - top,
  };
}

export const bandForLines = (body: HTMLElement, range: LineRange): Band | null =>
  bandOf(body, elementsForLines(body, range));

/** `[3, 4, 5, 9]` → `[[3, 5], [9, 9]]`. */
export function lineRuns(lines: readonly number[]): LineRange[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const runs: LineRange[] = [];
  for (const line of sorted) {
    const last = runs.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs;
}

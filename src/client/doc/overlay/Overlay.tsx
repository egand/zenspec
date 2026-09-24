/**
 * Decorations drawn over the rendered document: thread highlights with margin pins, diff marks,
 * and the focus pulse. Positions are measured from the DOM, so blocks never re-render for them.
 */
import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import type { DocFocus, DocHighlight } from "../types.js";
import { bandForLines, lineRuns, type Band } from "./geometry.js";

const KIND_ICON: Record<DocHighlight["kind"], string> = {
  comment: "❝",
  suggestion: "±",
  decision: "✓",
  explain: "?",
  general: "•",
};

const PIN_WIDTH = 36;

/**
 * A margin pin: the kind's icon plus the thread's number (`t12` → `12`), or `+` for a draft
 * item, whose id means nothing to the reader. The id itself is only in the tooltip.
 */
export function pinLabel(h: Pick<DocHighlight, "threadId" | "kind" | "status">) {
  const number = /^t(\d+)$/.exec(h.threadId)?.[1];
  return {
    icon: KIND_ICON[h.kind],
    number: number ?? "+",
    title: number
      ? `Thread ${h.threadId} · ${h.kind} · ${h.status}`
      : `Draft ${h.kind} (${h.threadId}), not submitted yet`,
  };
}

interface Props {
  body: RefObject<HTMLElement>;
  /** Changes whenever the rendered content may have moved. */
  layoutKey: unknown;
  highlights: DocHighlight[];
  diffLines?: { added: number[]; modified: number[] };
  focus?: DocFocus;
  onHighlightClick(threadId: string): void;
}

interface Placed {
  highlights: { h: DocHighlight; band: Band; slot: number }[];
  diffs: { kind: "added" | "modified"; band: Band }[];
}

const style = (b: Band) => ({
  top: `${b.top}px`,
  left: `${b.left}px`,
  width: `${b.width}px`,
  height: `${b.height}px`,
});

/** Re-measures when the body resizes (images load, diagrams render, window resizes). */
function useResizeTick(body: RefObject<HTMLElement>): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!body.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(body.current);
    return () => ro.disconnect();
  }, [body]);
  return tick;
}

export function Overlay({
  body,
  layoutKey,
  highlights,
  diffLines,
  focus,
  onHighlightClick,
}: Props) {
  const tick = useResizeTick(body);
  const [placed, setPlaced] = useState<Placed>({ highlights: [], diffs: [] });
  const [pulse, setPulse] = useState<{ band: Band; nonce: number } | null>(null);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const slots = new Map<number, number>();
    const hs = highlights.flatMap((h) => {
      const band = h.lines && bandForLines(el, h.lines);
      if (!band) return [];
      const top = Math.round(band.top);
      const slot = slots.get(top) ?? 0;
      slots.set(top, slot + 1);
      return [{ h, band, slot }];
    });
    const diffs = (["added", "modified"] as const).flatMap((kind) =>
      lineRuns(diffLines?.[kind] ?? []).flatMap((run) => {
        const band = bandForLines(el, run);
        return band ? [{ kind, band }] : [];
      }),
    );
    setPlaced({ highlights: hs, diffs });
  }, [body, layoutKey, highlights, diffLines, tick]);

  useEffect(() => {
    const el = body.current;
    if (!el || !focus) return;
    const lines = focus.threadId
      ? highlights.find((h) => h.threadId === focus.threadId)?.lines
      : focus.lines;
    const band = lines && bandForLines(el, lines);
    if (!band) return;
    const scroller = el.closest(".zen-doc-canvas");
    if (scroller) {
      const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const top = scroller.scrollTop + offset + band.top - scroller.clientHeight / 3;
      scroller.scrollTo?.({ top: Math.max(0, top), behavior: "smooth" });
    }
    setPulse({ band, nonce: focus.nonce });
    const timer = setTimeout(() => setPulse(null), 1800);
    return () => clearTimeout(timer);
    // Only a new nonce requests a scroll; highlight changes alone must not jump the page.
  }, [focus?.nonce]);

  return (
    <>
      <div class="zen-doc-deco zen-doc-deco-under" aria-hidden="true">
        {placed.diffs.map(({ kind, band }, i) => (
          <div key={`d${i}`} class={`zen-diff-mark zen-diff-${kind}`} style={style(band)} />
        ))}
        {placed.highlights.map(({ h, band }) => (
          <div
            key={h.threadId}
            class={`zen-hl zen-hl-${h.status} zen-hl-kind-${h.kind}${h.active ? " is-active" : ""}`}
            style={style(band)}
          />
        ))}
        {pulse && <div key={pulse.nonce} class="zen-pulse" style={style(pulse.band)} />}
      </div>
      <div class="zen-doc-deco zen-doc-deco-pins">
        {placed.highlights.map(({ h, band, slot }) => {
          const label = pinLabel(h);
          return (
            <button
              key={h.threadId}
              type="button"
              data-zen-ui
              class={`zen-pin zen-pin-${h.kind} zen-pin-${h.status}${h.active ? " is-active" : ""}`}
              style={{ top: `${band.top}px`, left: `${-(PIN_WIDTH + 8) - slot * PIN_WIDTH}px` }}
              title={label.title}
              aria-label={label.title}
              onClick={() => onHighlightClick(h.threadId)}
            >
              <span class="zen-pin-icon" aria-hidden="true">
                {label.icon}
              </span>
              {label.number}
            </button>
          );
        })}
      </div>
    </>
  );
}

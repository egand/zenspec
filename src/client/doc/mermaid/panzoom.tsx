/**
 * Zoom and pan for diagrams, used inline and in the lightbox.
 */
import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

export interface View {
  zoom: number;
  x: number;
  y: number;
}

const round = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

export interface PanZoom {
  view: View;
  dragging: boolean;
  zoomBy(delta: number): void;
  reset(): void;
  handlers: Pick<
    JSX.HTMLAttributes<HTMLDivElement>,
    "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onWheel" | "onDblClick"
  >;
}

/** `wheel: "modifier"` zooms only with Ctrl/Cmd (inline, so the page still scrolls). */
export function usePanZoom(opts: { min: number; max: number; wheel: "modifier" | "always" }) {
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const zoomBy = (delta: number) =>
    setView((v) => ({ ...v, zoom: clamp(round(v.zoom + delta), opts.min, opts.max) }));
  const reset = () => setView({ zoom: 1, x: 0, y: 0 });
  const stop = (e: PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  const pz: PanZoom = {
    view,
    dragging,
    zoomBy,
    reset,
    handlers: {
      onPointerDown(e) {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY, px: view.x, py: view.y };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDragging(true);
      },
      onPointerMove(e) {
        const d = drag.current;
        if (d) setView((v) => ({ ...v, x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }));
      },
      onPointerUp: stop,
      onPointerCancel: stop,
      onWheel(e) {
        if (opts.wheel === "modifier" && !e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 0.15 : -0.15);
      },
      onDblClick(e) {
        e.preventDefault();
        if (view.zoom !== 1 || view.x || view.y) reset();
        else setView({ ...view, zoom: 1.5 });
      },
    },
  };
  return pz;
}

/** Intrinsic size of an SVG, from its viewBox when present. */
export function svgSize(svg: SVGSVGElement): { width: number; height: number } {
  const box = svg
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box?.length === 4 && box[2]! > 0 && box[3]! > 0) return { width: box[2]!, height: box[3]! };
  const rect = svg.getBoundingClientRect();
  return { width: rect.width || 800, height: rect.height || 600 };
}

interface ViewportProps {
  svg: string;
  pz: PanZoom;
  /** `width`: shrink to the column width (inline). `contain`: fit width and height (lightbox). */
  fit: "width" | "contain";
  class: string;
}

/**
 * The pannable, zoomable surface. The SVG is Mermaid output (strict security level), injected
 * as markup; Preact leaves it alone while `svg` is unchanged, so zooming never re-renders it.
 */
export function DiagramViewport({ svg, pz, fit, class: cls }: ViewportProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = canvas.current?.querySelector("svg");
    if (!el) return;
    const size = svgSize(el);
    el.setAttribute("width", `${size.width}`);
    el.setAttribute("height", `${size.height}`);
    el.style.maxWidth = "none";
    setNatural(size);
  }, [svg]);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let base = 1;
  if (natural && box.width) {
    base =
      fit === "width"
        ? Math.min(1, (box.width - 48) / natural.width)
        : Math.max(
            0.25,
            Math.min((box.width - 80) / natural.width, (box.height - 80) / natural.height, 2.5),
          );
  }
  const { zoom, x, y } = pz.view;
  const height = fit === "width" && natural ? Math.max(120, natural.height * base + 48) : undefined;

  return (
    <div
      ref={viewport}
      class={`${cls}${pz.dragging ? " is-dragging" : ""}`}
      style={height ? { height: `${height}px` } : undefined}
      {...pz.handlers}
    >
      <div
        ref={canvas}
        class="zen-diagram-canvas"
        style={{
          transform: `translate(${x}px, ${y}px) scale(${round(base * zoom)})`,
          transition: pz.dragging ? "none" : undefined,
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

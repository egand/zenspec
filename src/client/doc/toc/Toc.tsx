/**
 * Outline sidebar with scrollspy and reading time, plus the reading progress bar. Each listens to
 * the canvas scroll itself, so scrolling re-renders only them. Living-plan step progress is
 * shown once, by the app shell.
 */
import type { RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";

export interface TocEntry {
  id: string;
  text: string;
  depth: number;
}

/** Runs `update` on scroll (once per frame) and immediately. */
function useScroll(
  canvas: RefObject<HTMLElement>,
  update: (el: HTMLElement) => void,
  deps: unknown[],
) {
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update(el);
      });
    };
    update(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [canvas, ...deps]);
}

export function ReadingProgress({ canvas }: { canvas: RefObject<HTMLElement> }) {
  const [pct, setPct] = useState(0);
  useScroll(
    canvas,
    (el) => {
      const max = el.scrollHeight - el.clientHeight;
      setPct(max > 0 ? Math.min(100, Math.max(0, (el.scrollTop / max) * 100)) : 0);
    },
    [],
  );
  return <div class="zen-reading-progress" style={{ width: `${pct}%` }} aria-hidden="true" />;
}

interface TocProps {
  canvas: RefObject<HTMLElement>;
  entries: TocEntry[];
  minutes: number;
}

export function Toc({ canvas, entries, minutes }: TocProps) {
  const [active, setActive] = useState<string | undefined>();
  useScroll(
    canvas,
    (el) => {
      const threshold = el.getBoundingClientRect().top + 100;
      let current: string | undefined = entries[0]?.id;
      for (const entry of entries) {
        const heading = document.getElementById(`zen-h-${entry.id}`);
        if (heading && heading.getBoundingClientRect().top <= threshold) current = entry.id;
        else if (heading) break;
      }
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) current = entries.at(-1)?.id;
      setActive(current);
    },
    [entries],
  );

  const go = (e: MouseEvent, id: string) => {
    e.preventDefault();
    document.getElementById(`zen-h-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  };

  return (
    <nav class="zen-toc" aria-label="Outline">
      <div class="zen-toc-header">
        <div class="zen-toc-heading">
          <h4>Outline</h4>
          <span class="zen-read-time">~{minutes} min read</span>
        </div>
      </div>
      <div class="zen-toc-list">
        {entries.length === 0 && <div class="zen-toc-empty">No headings</div>}
        {entries.map((entry) => (
          <a
            key={entry.id}
            href={`#zen-h-${entry.id}`}
            class={`zen-toc-item zen-toc-depth-${entry.depth}${active === entry.id ? " is-active" : ""}`}
            onClick={(e) => go(e, entry.id)}
          >
            {entry.text}
          </a>
        ))}
      </div>
    </nav>
  );
}

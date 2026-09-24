/**
 * HTML mockups (§12): the page runs in a sandboxed iframe (`allow-scripts`, no same-origin) and a
 * postMessage element picker reports `{ cssPath, tag, textQuote }` for the clicked element.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { SelectionToolbar } from "../selection/SelectionToolbar.js";
import type { DocumentViewProps, HtmlSelection, SelectAction } from "../types.js";
import { withPicker } from "./picker.js";

interface Picked {
  html: HtmlSelection["html"];
  top: number;
  left: number;
}

type Props = Pick<DocumentViewProps, "source" | "highlights" | "onSelect" | "onHighlightClick">;

export function HtmlView({ source, highlights, onSelect, onHighlightClick }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [ready, setReady] = useState(0);
  const srcdoc = useMemo(() => withPicker(source), [source]);
  const latest = useRef(onHighlightClick);
  latest.current = onHighlightClick;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const data = e.data as { zen?: string; [key: string]: unknown };
      if (data?.zen === "ready") setReady((n) => n + 1);
      if (data?.zen === "thread" && typeof data.threadId === "string")
        latest.current(data.threadId);
      if (data?.zen === "pick") {
        const rect = data.rect as { top: number; left: number; width: number };
        setPicked({
          html: {
            cssPath: String(data.cssPath),
            tag: String(data.tag),
            textQuote: String(data.textQuote),
          },
          top: Math.max(0, rect.top - 44),
          left: rect.left + rect.width / 2,
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Best effort: outline elements that have threads, once the page has loaded.
  useEffect(() => {
    const items = highlights
      .filter((h) => h.cssPath)
      .map(({ threadId, cssPath, status, active }) => ({ threadId, cssPath, status, active }));
    frame.current?.contentWindow?.postMessage({ zen: "highlights", items }, "*");
  }, [highlights, ready]);

  const act = (action: SelectAction) => {
    if (picked) onSelect({ html: picked.html, action });
    setPicked(null);
  };

  return (
    <div class="zen-doc zen-doc-html">
      <div class="zen-html-frame">
        <iframe
          ref={frame}
          title="HTML mockup"
          sandbox="allow-scripts"
          srcdoc={srcdoc}
          onLoad={() => setPicked(null)}
        />
        {picked && (
          <SelectionToolbar
            top={picked.top}
            left={picked.left}
            actions={["comment", "explain"]}
            onAction={act}
            onClose={() => setPicked(null)}
          />
        )}
      </div>
      <p class="zen-html-hint">
        Click any element to comment on it. Alt-click an outlined element to add another thread.
      </p>
    </div>
  );
}

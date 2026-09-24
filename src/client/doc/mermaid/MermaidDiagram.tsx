import { memo } from "preact/compat";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";
import { DocActionsContext, isDark } from "../context.js";
import { DiagramViewport, usePanZoom, type PanZoom } from "./panzoom.js";
import { renderMermaid } from "./render.js";

function ZoomControls({ pz, onExpand }: { pz: PanZoom; onExpand?: () => void }) {
  return (
    <div class="zen-diagram-zoom">
      <button
        type="button"
        class="zen-diagram-btn"
        title="Zoom out"
        onClick={() => pz.zoomBy(-0.25)}
      >
        −
      </button>
      <button type="button" class="zen-diagram-badge" title="Reset zoom" onClick={pz.reset}>
        {Math.round(pz.view.zoom * 100)}%
      </button>
      <button type="button" class="zen-diagram-btn" title="Zoom in" onClick={() => pz.zoomBy(0.25)}>
        +
      </button>
      <button type="button" class="zen-diagram-btn" title="Reset zoom and pan" onClick={pz.reset}>
        ⟲
      </button>
      {onExpand && (
        <button type="button" class="zen-diagram-btn" title="Open fullscreen" onClick={onExpand}>
          ⛶
        </button>
      )}
    </div>
  );
}

function Lightbox({ svg, onClose }: { svg: string; onClose: () => void }) {
  const pz = usePanZoom({ min: 0.2, max: 6, wheel: "always" });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return (
    <div class="zen-lightbox" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="zen-lightbox-panel" role="dialog" aria-label="Diagram">
        <div class="zen-lightbox-header">
          <span class="zen-lightbox-title">Diagram</span>
          <ZoomControls pz={pz} />
          <button type="button" class="zen-diagram-btn" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
        <DiagramViewport svg={svg} pz={pz} fit="contain" class="zen-lightbox-viewport" />
      </div>
    </div>
  );
}

/** A Mermaid diagram, rendered lazily and only again when its code or the theme changes. */
export const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  const { selectBlock } = useContext(DocActionsContext);
  const dark = isDark.value;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pz = usePanZoom({ min: 0.25, max: 5, wheel: "modifier" });
  const close = useCallback(() => setExpanded(false), []);

  useEffect(() => {
    let live = true;
    renderMermaid(code, dark).then(
      (out) => live && (setSvg(out), setError(null)),
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [code, dark]);

  const comment = () => {
    const block = root.current?.closest("[data-block-id]");
    if (block) selectBlock(block.getAttribute("data-block-id")!, root.current!);
  };

  return (
    <div class="zen-mermaid" ref={root}>
      <div class="zen-diagram-toolbar" data-zen-ui>
        <ZoomControls pz={pz} onExpand={svg ? () => setExpanded(true) : undefined} />
        <button type="button" class="zen-diagram-comment" onClick={comment}>
          Comment on diagram
        </button>
      </div>
      {error ? (
        <pre class="zen-diagram-error">{`Mermaid: ${error}\n\n${code}`}</pre>
      ) : svg ? (
        <DiagramViewport svg={svg} pz={pz} fit="width" class="zen-diagram-viewport" />
      ) : (
        <div class="zen-diagram-loading">Rendering diagram…</div>
      )}
      {expanded && svg && <Lightbox svg={svg} onClose={close} />}
    </div>
  );
});

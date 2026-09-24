/**
 * The Markdown document: outline, reading progress, keyed blocks, decorations, the selection
 * toolbar, and focus mode (`z`).
 */
import { toString } from "mdast-util-to-string";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { parseDocument } from "../../core/parse.js";
import { Block } from "./blocks/Block.js";
import { decorate } from "./blocks/decorate.js";
import { DocActionsContext, type DocActions } from "./context.js";
import { loadDismissed, saveDismissed } from "./kb/terms.js";
import { Overlay } from "./overlay/Overlay.js";
import { captureSelection, wholeBlock, type PendingText } from "./selection/capture.js";
import { SelectionToolbar } from "./selection/SelectionToolbar.js";
import { ReadingProgress, Toc, type TocEntry } from "./toc/Toc.js";
import type { DocumentViewProps, SelectAction } from "./types.js";

const WORDS_PER_MINUTE = 200;
const TOOLBAR_OFFSET = 44;
const BLOCK_TOOLBAR_LEFT = 140;
const BLOCK_TRIGGERS = ".zen-gutter, .zen-diagram-comment";

interface Pending {
  /** `text`: a browser selection (dropped when it collapses); `block`: a gutter click. */
  kind: "text" | "block";
  sel: PendingText;
  top: number;
  left: number;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** Focus mode hides the outline here and sets `html.zen-focus-mode` for the rest of the app. */
function useFocusMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "z" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      setOn((v) => !v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("zen-focus-mode", on);
  }, [on]);
  useEffect(() => () => document.documentElement.classList.remove("zen-focus-mode"), []);
  return [on, setOn];
}

export function MarkdownView(props: DocumentViewProps) {
  const { source } = props;
  const doc = useMemo(() => parseDocument(source), [source]);
  const [dismissed, setDismissed] = useState(loadDismissed);
  const terms = useMemo(
    () => (props.kbTerms ?? []).filter((t) => !dismissed.has(t.term)),
    [props.kbTerms, dismissed],
  );
  const decos = useMemo(
    () => decorate(doc, { answers: props.answers, steps: props.steps, terms }),
    [doc, props.answers, props.steps, terms],
  );

  const outline = useMemo(() => {
    const entries: TocEntry[] = [];
    let words = 0;
    for (const block of doc.blocks) {
      const text = toString(block.node);
      words += text.split(/\s+/).filter(Boolean).length;
      if (block.node.type === "heading" && block.node.depth <= 3) {
        entries.push({ id: block.id, text: text.trim(), depth: block.node.depth });
      }
    }
    return { entries, minutes: Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)) };
  }, [doc]);

  const body = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const latest = useRef({ props, doc });
  latest.current = { props, doc };
  const [pending, setPending] = useState<Pending | null>(null);
  const [focusMode, setFocusMode] = useFocusMode();

  const place = (rect: DOMRect): { top: number; left: number } => {
    const origin = body.current!.getBoundingClientRect();
    return {
      top: Math.max(0, rect.top - origin.top - TOOLBAR_OFFSET),
      left: rect.left - origin.left + rect.width / 2,
    };
  };

  const actions = useMemo<DocActions>(
    () => ({
      answer: (id, choice, note) => latest.current.props.onAnswer(id, choice, note),
      dismissTerm: (term) =>
        setDismissed((prev) => {
          const next = new Set(prev).add(term);
          saveDismissed(next);
          return next;
        }),
      selectBlock: (blockId, anchor) => {
        const { props: p, doc: d } = latest.current;
        const sel = wholeBlock(p.source, d, blockId);
        if (!sel || !body.current) return;
        const { top, left } = place(anchor.getBoundingClientRect());
        setPending({ kind: "block", sel, top, left: Math.min(left, BLOCK_TOOLBAR_LEFT) });
      },
    }),
    [],
  );

  const onPointerUp = (e: Event) => {
    if (!body.current) return;
    const hit = captureSelection(body.current, source, doc);
    if (hit) {
      setPending({ kind: "text", sel: hit.sel, ...place(hit.range.getBoundingClientRect()) });
    } else if (!(e.target as Element | null)?.closest?.(`${BLOCK_TRIGGERS}, .zen-sel-toolbar`)) {
      setPending(null);
    }
  };

  // Hide the toolbar when the text selection goes away (a gutter selection stays).
  useEffect(() => {
    const onChange = () => {
      if (document.getSelection()?.isCollapsed) {
        setPending((p) => (p?.kind === "text" ? null : p));
      }
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  const act = (action: SelectAction) => {
    if (!pending) return;
    props.onSelect({ ...pending.sel, action });
    setPending(null);
    document.getSelection()?.removeAllRanges();
  };

  return (
    <DocActionsContext.Provider value={actions}>
      <div class={`zen-doc${focusMode ? " is-focus" : ""}`}>
        <aside class="zen-doc-toc">
          <Toc canvas={canvas} {...outline} />
        </aside>
        <div class="zen-doc-main">
          <ReadingProgress canvas={canvas} />
          <div class="zen-doc-canvas" ref={canvas}>
            <article
              class="zen-doc-body"
              ref={body}
              onMouseUp={onPointerUp}
              onKeyUp={(e) => e.shiftKey && onPointerUp(e)}
            >
              <Overlay
                body={body}
                layoutKey={doc}
                highlights={props.highlights}
                diffLines={props.diffLines}
                focus={props.focus}
                onHighlightClick={props.onHighlightClick}
              />
              {doc.blocks.map((block) => (
                <Block key={block.id} block={block} deco={decos.get(block.id)!} />
              ))}
              {pending && (
                <SelectionToolbar
                  top={pending.top}
                  left={pending.left}
                  actions={["comment", "suggest", "explain"]}
                  onAction={act}
                  onClose={() => setPending(null)}
                />
              )}
            </article>
          </div>
        </div>
        {focusMode && (
          <button type="button" class="zen-focus-exit" onClick={() => setFocusMode(false)}>
            Exit focus mode <kbd>z</kbd>
          </button>
        )}
      </div>
    </DocActionsContext.Provider>
  );
}

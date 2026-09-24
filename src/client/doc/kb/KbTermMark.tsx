import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { DocActionsContext } from "../context.js";
import type { KbTerm } from "../types.js";

/** A known term with a hover card: summary, "Open note", and "Got it" to stop underlining it. */
export function KbTermMark({ term, text }: { term: KbTerm; text: string }) {
  const { dismissTerm } = useContext(DocActionsContext);
  const [open, setOpen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => {
    clearTimeout(hideTimer.current);
    setOpen(true);
  };
  const hide = () => {
    hideTimer.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  return (
    <span
      class="zen-kb-term"
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {text}
      {open && (
        <span class="zen-kb-card" role="tooltip" data-zen-ui>
          <span class="zen-kb-card-title">{term.term}</span>
          <span class="zen-kb-card-summary">{term.summary}</span>
          <span class="zen-kb-card-actions">
            <a href={term.link} target="_blank" rel="noopener noreferrer">
              Open note
            </a>
            <button type="button" onClick={() => dismissTerm(term.term)}>
              Got it
            </button>
          </span>
        </span>
      )}
    </span>
  );
}

import { Fragment } from "preact";
import { useEffect } from "preact/hooks";
import type { SelectAction } from "../types.js";

const LABELS: Record<SelectAction, string> = {
  comment: "Comment",
  suggest: "Suggest edit",
  explain: "Explain",
};

interface Props {
  top: number;
  left: number;
  actions: SelectAction[];
  onAction(action: SelectAction): void;
  onClose(): void;
}

/** Floating pill above a selection: Comment · Suggest edit · Explain. */
export function SelectionToolbar({ top, left, actions, onAction, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      class="zen-sel-toolbar"
      data-zen-ui
      role="toolbar"
      style={{ top: `${top}px`, left: `${left}px` }}
      // Keep the text selection alive while clicking.
      onMouseDown={(e) => e.preventDefault()}
    >
      {actions.map((action, i) => (
        <Fragment key={action}>
          {i > 0 && <span class="zen-sel-sep" aria-hidden="true" />}
          <button type="button" data-action={action} onClick={() => onAction(action)}>
            {LABELS[action]}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

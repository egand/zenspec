import type { ComponentChildren } from "preact";

/** A centered dialog. Cmd/Ctrl+Enter submits; Esc is handled by the global shortcuts. */
export function Modal({
  title,
  onClose,
  onSubmit,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  onSubmit?: () => void;
  children: ComponentChildren;
  wide?: boolean;
}) {
  return (
    <div class="zen-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        class={`zen-modal${wide ? " zen-modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit?.();
          }
        }}
      >
        <header class="zen-modal-header">
          <h2>{title}</h2>
          <button type="button" class="zen-icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div class="zen-modal-body">{children}</div>
      </form>
    </div>
  );
}

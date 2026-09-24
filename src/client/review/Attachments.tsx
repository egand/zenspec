/** Image attachments (plan §9.2): paste or drop into any text field, thumbnails, lightbox. */
import { useState } from "preact/hooks";
import type { AttachmentRef } from "../../core/types.js";
import { useApp } from "../app/actions.js";
import { attachImages, imageFiles } from "../store/images.js";

/** Paste/drop handlers for a text field, plus the attachments gathered so far. */
export function useImageDrop(initial: AttachmentRef[] = []) {
  const { store } = useApp();
  const [attachments, setAttachments] = useState<AttachmentRef[]>(initial);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const add = async (files: File[]) => {
    if (!files.length) return;
    setUploading((n) => n + files.length);
    setError(null);
    try {
      const refs = await attachImages(files, store.api.uploadAttachment);
      setAttachments((list) => [...list, ...refs.filter((r) => !list.some((a) => a.id === r.id))]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading((n) => n - files.length);
    }
  };

  const handlers = {
    onPaste: (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      void add(files);
    },
    onDragOver: (e: DragEvent) => {
      if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      const files = imageFiles(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault();
      void add(files);
    },
  };

  const remove = (id: string) => setAttachments((list) => list.filter((a) => a.id !== id));
  return { attachments, uploading, error, handlers, remove, add };
}

export function Thumbnails({
  attachments,
  onRemove,
}: {
  attachments: readonly AttachmentRef[];
  onRemove?: (id: string) => void;
}) {
  const { store, ui } = useApp();
  if (!attachments.length) return null;
  return (
    <div class="zen-thumbs">
      {attachments.map((a) => {
        const src = store.api.attachmentUrl(a.id);
        return (
          <span class="zen-thumb" key={a.id}>
            <button
              type="button"
              class="zen-thumb-open"
              title={`${a.width}×${a.height}`}
              onClick={() => (ui.lightbox.value = src)}
            >
              <img src={src} alt="Attached image" loading="lazy" />
            </button>
            {onRemove && (
              <button
                type="button"
                class="zen-thumb-remove"
                aria-label="Remove image"
                onClick={() => onRemove(a.id)}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** A textarea that accepts pasted and dropped images, with the thumbnails below it. */
export function RichField({
  value,
  onInput,
  images,
  placeholder,
  autoFocus,
  rows = 4,
}: {
  value: string;
  onInput: (value: string) => void;
  images: ReturnType<typeof useImageDrop>;
  placeholder?: string;
  autoFocus?: boolean;
  rows?: number;
}) {
  return (
    <div class="zen-field">
      <textarea
        class="zen-textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onInput={(e) => onInput((e.currentTarget as HTMLTextAreaElement).value)}
        {...images.handlers}
      />
      <div class="zen-field-hint">
        {images.uploading > 0
          ? "Uploading image…"
          : (images.error ?? "Paste or drop an image to attach it")}
      </div>
      <Thumbnails attachments={images.attachments} onRemove={images.remove} />
    </div>
  );
}

export function Lightbox() {
  const { ui } = useApp();
  const src = ui.lightbox.value;
  if (!src) return null;
  return (
    <div
      class="zen-image-lightbox"
      role="dialog"
      aria-label="Image"
      onClick={() => (ui.lightbox.value = null)}
    >
      <img src={src} alt="Attachment" onClick={(e) => e.stopPropagation()} />
      <button type="button" class="zen-image-lightbox-close" aria-label="Close">
        ×
      </button>
    </div>
  );
}

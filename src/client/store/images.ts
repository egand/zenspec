/**
 * Pasted and dropped images (plan §9.2): downscaled in the browser to at most 1568 px on the
 * long edge, then uploaded through the attachment route.
 */
import type { AttachmentRef } from "../../core/types.js";

export const MAX_EDGE = 1568;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

/** Target size keeping the aspect ratio, or `null` when the image already fits. */
export function fitWithin(width: number, height: number, max = MAX_EDGE) {
  const long = Math.max(width, height);
  if (long <= max) return null;
  const scale = max / long;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** PNG stays PNG (screenshots keep sharp text); photos stay JPEG/WebP; anything else becomes PNG. */
export function outputType(type: string): string {
  return ACCEPTED.includes(type) ? type : "image/png";
}

export async function downscale(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = fitWithin(bitmap.width, bitmap.height);
    const type = outputType(file.type);
    if (!size && type === file.type) return file;
    const { width, height } = size ?? { width: bitmap.width, height: bitmap.height };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image"))),
        type,
        type === "image/png" ? undefined : 0.9,
      ),
    );
  } finally {
    bitmap.close?.();
  }
}

export async function attachImages(
  files: readonly File[],
  upload: (image: Blob) => Promise<AttachmentRef>,
): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const file of files) refs.push(await upload(await downscale(file)));
  return refs;
}

export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = [...(data.items ?? [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((f): f is File => !!f);
  if (fromItems.length) return fromItems;
  return [...(data.files ?? [])].filter((f) => f.type.startsWith("image/"));
}

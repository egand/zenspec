/**
 * Attachment validation (plan §9.2). The browser downscales before uploading, so the daemon
 * only checks the format by its magic bytes, reads the dimensions, and hashes the bytes.
 */
import { createHash } from "node:crypto";
import type { AttachmentRef } from "../core/types.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
}

/** Format and size of a PNG, JPEG or WebP image, or null if the bytes are not one. */
export function probeImage(bytes: Buffer): ImageInfo | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}

export function attachmentId(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

export function attachmentRef(bytes: Buffer, info: ImageInfo): AttachmentRef {
  return { id: attachmentId(bytes), mime: info.mime, width: info.width, height: info.height };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(b: Buffer): ImageInfo | null {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  return sized("image/png", b.readUInt32BE(16), b.readUInt32BE(20));
}

function jpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const length = b.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return sized("image/jpeg", b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
    }
    i += 2 + length;
  }
  return null;
}

function webp(b: Buffer): ImageInfo | null {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF") return null;
  if (b.toString("latin1", 8, 12) !== "WEBP") return null;
  switch (b.toString("latin1", 12, 16)) {
    case "VP8 ":
      return sized("image/webp", b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    case "VP8L": {
      const bits = b.readUInt32LE(21);
      return sized("image/webp", (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    case "VP8X":
      return sized("image/webp", b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
    default:
      return null;
  }
}

function sized(mime: ImageMime, width: number, height: number): ImageInfo | null {
  return width > 0 && height > 0 ? { mime, width, height } : null;
}

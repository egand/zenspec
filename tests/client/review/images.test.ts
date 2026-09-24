// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachImages,
  downscale,
  fitWithin,
  imageFiles,
  outputType,
} from "../../../src/client/store/images.js";

function mockCanvas() {
  const drawImage = vi.fn();
  const toBlob = vi.fn((cb: (b: Blob | null) => void, type: string) =>
    cb(new Blob(["scaled"], { type })),
  );
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob };
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
    tag === "canvas" ? canvas : create(tag)) as typeof document.createElement);
  return { canvas, drawImage, toBlob };
}

function mockBitmap(width: number, height: number) {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close: vi.fn() })),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("image attachments (§9.2)", () => {
  it("fits the long edge within 1568 px, keeping the aspect ratio", () => {
    expect(fitWithin(3136, 1000)).toEqual({ width: 1568, height: 500 });
    expect(fitWithin(1000, 4704)).toEqual({ width: 333, height: 1568 });
    expect(fitWithin(1568, 800)).toBeNull();
  });

  it("keeps PNG for screenshots and JPEG/WebP for photos", () => {
    expect(outputType("image/png")).toBe("image/png");
    expect(outputType("image/jpeg")).toBe("image/jpeg");
    expect(outputType("image/webp")).toBe("image/webp");
    expect(outputType("image/gif")).toBe("image/png");
  });

  it("downscales a large screenshot on a canvas and uploads the result", async () => {
    mockBitmap(3200, 1600);
    const { canvas, drawImage, toBlob } = mockCanvas();
    const upload = vi.fn(async (blob: Blob) => ({
      id: "abcdef123456",
      mime: blob.type as "image/png",
      width: canvas.width,
      height: canvas.height,
    }));

    const refs = await attachImages([new File(["big"], "shot.png", { type: "image/png" })], upload);

    expect(canvas.width).toBe(1568);
    expect(canvas.height).toBe(784);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1568, 784);
    expect(toBlob.mock.calls[0]![1]).toBe("image/png");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await (upload.mock.calls[0]![0] as Blob).text()).toBe("scaled");
    expect(refs).toEqual([{ id: "abcdef123456", mime: "image/png", width: 1568, height: 784 }]);
  });

  it("uploads small images untouched", async () => {
    mockBitmap(800, 600);
    const { toBlob } = mockCanvas();
    const file = new File(["small"], "photo.jpg", { type: "image/jpeg" });
    expect(await downscale(file)).toBe(file);
    expect(toBlob).not.toHaveBeenCalled();
  });

  it("takes only image files from a paste or drop", () => {
    const png = new File(["x"], "a.png", { type: "image/png" });
    const txt = new File(["x"], "a.txt", { type: "text/plain" });
    const data = {
      items: [
        { kind: "file", type: "image/png", getAsFile: () => png },
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "text/plain", getAsFile: () => txt },
      ],
      files: [],
    } as unknown as DataTransfer;
    expect(imageFiles(data)).toEqual([png]);
  });
});

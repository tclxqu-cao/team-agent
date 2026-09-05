import { describe, expect, it, vi } from "vitest";
import {
  COMPOSER_IMAGE_QUALITY,
  constrainedImageSize,
  normalizeComposerImage,
  type BrowserImageNormalizer,
} from "./browser-image-normalization";

function imageBlob(size: number, type = "image/png"): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

function fakeNormalizer(options: {
  width?: number;
  height?: number;
  output?: Blob | null;
  decodeError?: Error;
} = {}) {
  const dispose = vi.fn();
  const decode = options.decodeError
    ? vi.fn().mockRejectedValue(options.decodeError)
    : vi.fn().mockResolvedValue({
        source: {} as CanvasImageSource,
        width: options.width ?? 1000,
        height: options.height ?? 800,
        dispose,
      });
  const encode = vi.fn().mockResolvedValue(options.output ?? null);
  return { normalizer: { decode, encode } as BrowserImageNormalizer, decode, encode, dispose };
}

describe("normalizeComposerImage", () => {
  it("preserves GIF files without decoding them", async () => {
    const original = imageBlob(3 * 1024 * 1024, "image/gif");
    const fake = fakeNormalizer();

    await expect(normalizeComposerImage(original, fake.normalizer)).resolves.toBe(original);
    expect(fake.decode).not.toHaveBeenCalled();
  });

  it("preserves a small image within the dimension limit", async () => {
    const original = imageBlob(1024, "image/png");
    const fake = fakeNormalizer({ width: 1200, height: 900 });

    await expect(normalizeComposerImage(original, fake.normalizer)).resolves.toBe(original);
    expect(fake.encode).not.toHaveBeenCalled();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("resizes by the longest edge and keeps a smaller WebP result", async () => {
    const original = imageBlob(3 * 1024 * 1024, "image/png");
    const compressed = imageBlob(400 * 1024, "image/webp");
    const fake = fakeNormalizer({ width: 4000, height: 3000, output: compressed });

    await expect(normalizeComposerImage(original, fake.normalizer)).resolves.toBe(compressed);
    expect(fake.encode).toHaveBeenCalledWith(
      expect.anything(),
      2048,
      1536,
      "image/webp",
      COMPOSER_IMAGE_QUALITY,
    );
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("keeps JPEG output as JPEG", async () => {
    const original = imageBlob(3 * 1024 * 1024, "image/jpeg");
    const compressed = imageBlob(300 * 1024, "image/jpeg");
    const fake = fakeNormalizer({ output: compressed });

    await expect(normalizeComposerImage(original, fake.normalizer)).resolves.toBe(compressed);
    expect(fake.encode).toHaveBeenCalledWith(
      expect.anything(),
      1000,
      800,
      "image/jpeg",
      COMPOSER_IMAGE_QUALITY,
    );
  });

  it("falls back to the original when encoding grows the image", async () => {
    const original = imageBlob(3 * 1024 * 1024, "image/png");
    const larger = imageBlob(4 * 1024 * 1024, "image/webp");
    const fake = fakeNormalizer({ output: larger });

    await expect(normalizeComposerImage(original, fake.normalizer)).resolves.toBe(original);
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("falls back to the original when decoding fails", async () => {
    const original = imageBlob(3 * 1024 * 1024, "image/png");
    const fake = fakeNormalizer({ decodeError: new Error("decode failed") });

    await expect(normalizeComposerImage(original, fake.normalizer)).resolves.toBe(original);
    expect(fake.encode).not.toHaveBeenCalled();
  });
});

describe("constrainedImageSize", () => {
  it("preserves aspect ratio in landscape and portrait images", () => {
    expect(constrainedImageSize(4000, 3000)).toEqual({ width: 2048, height: 1536 });
    expect(constrainedImageSize(1500, 3000)).toEqual({ width: 1024, height: 2048 });
  });
});

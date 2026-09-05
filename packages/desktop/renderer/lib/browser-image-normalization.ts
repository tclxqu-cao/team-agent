export const COMPOSER_IMAGE_MAX_EDGE = 2048;
export const COMPOSER_IMAGE_SIZE_THRESHOLD = 2 * 1024 * 1024;
export const COMPOSER_IMAGE_QUALITY = 0.85;

interface DecodedBrowserImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose(): void;
}

export interface BrowserImageNormalizer {
  decode(blob: Blob): Promise<DecodedBrowserImage>;
  encode(
    image: DecodedBrowserImage,
    width: number,
    height: number,
    mimeType: "image/jpeg" | "image/webp",
    quality: number,
  ): Promise<Blob | null>;
}

export function constrainedImageSize(
  width: number,
  height: number,
  maxEdge = COMPOSER_IMAGE_MAX_EDGE,
): { width: number; height: number } {
  const longestEdge = Math.max(width, height);
  if (longestEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function normalizeComposerImage(
  file: Blob,
  normalizer: BrowserImageNormalizer = browserImageNormalizer,
): Promise<Blob> {
  if (file.type.toLowerCase() === "image/gif") return file;

  let image: DecodedBrowserImage | null = null;
  try {
    image = await normalizer.decode(file);
    const target = constrainedImageSize(image.width, image.height);
    const needsResize = target.width !== image.width || target.height !== image.height;
    if (!needsResize && file.size <= COMPOSER_IMAGE_SIZE_THRESHOLD) return file;

    const outputType = file.type.toLowerCase() === "image/jpeg" ? "image/jpeg" : "image/webp";
    const compressed = await normalizer.encode(
      image,
      target.width,
      target.height,
      outputType,
      COMPOSER_IMAGE_QUALITY,
    );
    return compressed && compressed.size < file.size ? compressed : file;
  } catch {
    return file;
  } finally {
    image?.dispose();
  }
}

const browserImageNormalizer: BrowserImageNormalizer = {
  decode(blob) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      let settled = false;
      const dispose = () => URL.revokeObjectURL(objectUrl);
      image.onload = () => {
        settled = true;
        resolve({
          source: image,
          width: image.naturalWidth,
          height: image.naturalHeight,
          dispose,
        });
      };
      image.onerror = () => {
        if (!settled) dispose();
        reject(new Error("无法解码图片"));
      };
      image.src = objectUrl;
    });
  },
  encode(image, width, height, mimeType, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return Promise.resolve(null);
    context.drawImage(image.source, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
  },
};

import { RuntimeSessionError } from "./types.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export type SupportedImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export interface ParsedImageDataUrl {
  mimeType: SupportedImageMimeType;
  extension: "jpg" | "png" | "gif" | "webp";
  base64: string;
  bytes: Buffer;
}

const IMAGE_EXTENSIONS: Record<SupportedImageMimeType, ParsedImageDataUrl["extension"]> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function parseImageDataUrls(images: readonly string[] | undefined): ParsedImageDataUrl[] {
  return (images ?? []).map((image, index) => parseImageDataUrl(image, index));
}

function parseImageDataUrl(value: string, index: number): ParsedImageDataUrl {
  const label = `Image ${index + 1}`;
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) {
    throw invalidImage(`${label} must be a base64 JPEG, PNG, GIF, or WebP data URL`);
  }

  const mimeType = match[1] as SupportedImageMimeType;
  const base64 = match[2];
  if (base64.length % 4 !== 0 || base64.length > MAX_BASE64_LENGTH) {
    throw invalidImage(`${label} is malformed or exceeds the 20 MB limit`);
  }

  const bytes = Buffer.from(base64, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (canonical !== base64.replace(/=+$/, "") || !hasExpectedSignature(mimeType, bytes)) {
    throw invalidImage(`${label} content does not match its declared media type`);
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw invalidImage(`${label} exceeds the 20 MB limit`);
  }

  return {
    mimeType,
    extension: IMAGE_EXTENSIONS[mimeType],
    base64,
    bytes,
  };
}

function hasExpectedSignature(mimeType: SupportedImageMimeType, bytes: Buffer): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function invalidImage(message: string): RuntimeSessionError {
  return new RuntimeSessionError(message, "NATIVE_PROTOCOL_ERROR");
}

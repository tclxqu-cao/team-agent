import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PendingImage {
  name: string;
  dataUrl: string;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function isImageExtension(pathValue: string): boolean {
  const ext = path.extname(pathValue).slice(1).toLowerCase();
  return ext in IMAGE_MIME;
}

/** Expand ~ and resolve an image path against the working directory. */
export function resolveImagePath(pathValue: string): string {
  const expanded = pathValue.replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(expanded);
}

/** Read a local image file as a base64 data URL for vision messages. */
export async function readImageFile(pathValue: string): Promise<PendingImage> {
  const resolved = resolveImagePath(pathValue);
  const ext = path.extname(resolved).slice(1).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new Error("仅支持 png/jpg/jpeg/gif/webp 图片");
  const buffer = await fsp.readFile(resolved);
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("图片超过 5MB 上限");
  return { name: path.basename(resolved), dataUrl: `data:${mime};base64,${buffer.toString("base64")}` };
}

/** Absolute image paths appearing in the message text (drag-drop pastes paths). */
export function extractImagePaths(input: string): string[] {
  const matches = input.matchAll(/(?:^|[\s"'])(\/[^\s"']+)/g);
  const paths: string[] = [];
  for (const match of matches) {
    const candidate = match[1];
    if (isImageExtension(candidate) && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

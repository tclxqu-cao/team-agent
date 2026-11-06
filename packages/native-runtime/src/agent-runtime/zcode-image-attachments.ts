import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { MAX_IMAGE_BYTES, parseImageDataUrls, type ParsedImageDataUrl } from "./image-input.js";
import { nativeRecord } from "./native-rpc-client.js";

export interface ZCodeImageAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
}

/** Native file parts use artifact URLs; our retained upload is the preview source. */
export async function readZCodeHistoryImages(value: unknown, storageRoot: string): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  if (!Array.isArray(value)) return images;
  for (const row of value) {
    if (nativeRecord(nativeRecord(row).info).role !== "user") continue;
    const parts = nativeRecord(row).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts.map(nativeRecord)) {
      if (part.type !== "file" || typeof part.url !== "string" || images.has(part.url)
        || typeof part.mime !== "string" || !/^image\/(?:jpeg|png|gif|webp)$/.test(part.mime)) continue;
      const path = nativeRecord(part.source).path;
      if (typeof path !== "string" || !isAbsolute(path)) continue;
      const within = relative(storageRoot, path);
      if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) continue;
      let handle;
      try {
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) continue;
        const image = `data:${part.mime};base64,${(await handle.readFile()).toString("base64")}`;
        parseImageDataUrls([image]);
        images.set(part.url, image);
      } catch { /* Missing previews must not prevent native history from loading. */ }
      finally { await handle?.close(); }
    }
  }
  return images;
}

/** Local paths keep multiple photos below the native NDJSON frame limit.
 * Retain accepted/uncertain sends because native history may still reference them. */
export async function persistZCodeImageAttachments(
  images: readonly ParsedImageDataUrl[],
  storageRoot: string,
): Promise<ZCodeImageAttachment[]> {
  if (!images.length) return [];
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(storageRoot, "images-"));
  try {
    const attachments: ZCodeImageAttachment[] = [];
    for (const [index, image] of images.entries()) {
      const filename = `image-${index + 1}.${image.extension}`;
      const localPath = join(directory, filename);
      await writeFile(localPath, image.bytes, { mode: 0o600, flag: "wx" });
      attachments.push({ kind: "image", filename, mimeType: image.mimeType, sizeBytes: image.bytes.length, localPath });
    }
    return attachments;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

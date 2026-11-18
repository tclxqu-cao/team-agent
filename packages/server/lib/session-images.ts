import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { optimizeImage } from "next/dist/server/image-optimizer";
import type { MessageAttachment } from "@agent/core";
import { getServerBaseDir } from "./server-data-dir";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" };
interface ImageSource { mime: string; path?: string; stamp?: string }
type ImageRecord = Record<string, unknown>;

/** Only derived display resources are cached; original native files are never modified. */
export class SessionImageStore {
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly directory: string,
    private readonly compress = (buffer: Buffer) => optimizeImage({ buffer, contentType: "image/webp", width: 384, quality: 60 })) {}

  private file(id: string, suffix: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid image identity");
    return join(this.directory, `${id}.${suffix}`);
  }

  async register(attachment: MessageAttachment): Promise<MessageAttachment> {
    const { localImagePath, dataUrl, ...display } = attachment;
    if (!localImagePath && !dataUrl?.startsWith("data:image/")) return { ...display, ...(dataUrl ? { dataUrl } : {}) };
    try {
      let source: ImageSource;
      let bytes: Buffer | undefined;
      if (localImagePath) {
        const metadata = await stat(localImagePath);
        const mime = MIME[extname(localImagePath).toLowerCase()];
        if (!mime || !metadata.isFile() || metadata.size > MAX_IMAGE_BYTES) throw new Error("Image unavailable");
        source = { path: localImagePath, mime, stamp: `${metadata.size}:${metadata.mtimeMs}` };
      } else {
        const match = /^data:(image\/(?:png|jpeg|webp|gif|avif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl!);
        if (!match || match[2].length > MAX_IMAGE_BYTES * 4 / 3 + 4) throw new Error("Invalid image");
        bytes = Buffer.from(match[2], "base64");
        source = { mime: match[1] };
      }
      const id = createHash("sha256").update(JSON.stringify(source)).update(bytes ?? "").digest("hex");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (bytes) await this.writeOnce(this.file(id, "original"), bytes);
      await this.writeOnce(this.file(id, "json"), JSON.stringify(source));
      return { ...display, imageId: id, unavailable: undefined, omitted: undefined };
    } catch {
      return { ...display, unavailable: true };
    }
  }

  private async writeOnce(path: string, content: string | Buffer): Promise<void> {
    try { await stat(path); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  async read(id: string, variant: "preview" | "original"): Promise<string> {
    const key = `${id}:${variant}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = this.load(id, variant);
    this.pending.set(key, pending);
    try { return await pending; }
    finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
  }

  private async load(id: string, variant: "preview" | "original"): Promise<string> {
    if (variant === "preview") {
      try { return `data:image/webp;base64,${(await readFile(this.file(id, "webp"))).toString("base64")}`; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const source = JSON.parse(await readFile(this.file(id, "json"), "utf8")) as ImageSource;
    const path = source.path ?? this.file(id, "original");
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_IMAGE_BYTES
      || (source.stamp && source.stamp !== `${metadata.size}:${metadata.mtimeMs}`)) throw new Error("Image unavailable");
    const bytes = await readFile(path);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image unavailable");
    if (variant === "original") return `data:${source.mime};base64,${bytes.toString("base64")}`;
    const preview = await this.compress(bytes);
    await this.writeOnce(this.file(id, "webp"), preview);
    return `data:image/webp;base64,${preview.toString("base64")}`;
  }

  /** Apply only to display messages/events; never mutate the stored model input or queue. */
  async project<T extends { messages?: unknown; events?: unknown }>(detail: T): Promise<T> {
    if (!detail) return detail;
    const projectMessage = async (value: unknown): Promise<unknown> => {
      if (!value || typeof value !== "object") return value;
      const message = value as ImageRecord;
      const presentation = message.presentation as ImageRecord | undefined;
      const attachments = Array.isArray(presentation?.attachments) ? presentation.attachments as MessageAttachment[] : [];
      const images = Array.isArray(message.images) ? message.images.filter((image): image is string => typeof image === "string") : [];
      if (!attachments.length && !images.length) return value;
      const projected = await Promise.all([...attachments, ...images.map((dataUrl, index) => ({
        type: "image" as const, name: `图片 ${index + 1}`, dataUrl,
      }))].map(attachment => this.register(attachment)));
      return { ...message, images: undefined, presentation: { ...presentation, attachments: projected } };
    };
    return {
      ...detail,
      ...(Array.isArray(detail.messages) ? { messages: await Promise.all(detail.messages.map(projectMessage)) } : {}),
      ...(Array.isArray(detail.events) ? { events: await Promise.all(detail.events.map(async value => {
        const event = await projectMessage(value) as ImageRecord;
        return event && typeof event === "object" && event.message && typeof event.message === "object"
          ? { ...event, message: await projectMessage(event.message) } : event;
      })) } : {}),
    };
  }
}

let store: SessionImageStore | undefined;
export function getSessionImageStore(): SessionImageStore {
  return store ??= new SessionImageStore(join(getServerBaseDir(), ".agent-data", "cache", "session-images"));
}

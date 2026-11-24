import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PromptAttachment } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";

/** Antigravity's local tools consume binary files by path. Its workspace
 * allowlist includes only the directory owned by this connection. */
export class AcpAttachmentStore {
  private directory?: Promise<string>;

  root(): Promise<string> {
    return this.directory ??= mkdtemp(join(tmpdir(), "agentroam-acp-files-")).then(path => realpath(path))
      .catch(error => { this.directory = undefined; throw error; });
  }

  async stage(name: string, bytes: Buffer): Promise<string> {
    const root = await this.root();
    const subdirectory = await mkdtemp(join(root, "attachment-"));
    const file = join(subdirectory, name);
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    return file;
  }

  async dispose(): Promise<void> {
    const directory = await this.directory?.catch(() => undefined);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function acpAttachmentBlocks(attachments: readonly PromptAttachment[], localFiles?: AcpAttachmentStore): Promise<NativeJsonPacket[]> {
  const blocks = await Promise.all(attachments.map(async ({ name, mimeType, data }, index): Promise<NativeJsonPacket[]> => {
    const uri = `file:///agentroam-attachments/${index + 1}/${encodeURIComponent(name)}`;
    const bytes = Buffer.from(data, "base64");
    let text: string | undefined;
    if (!bytes.includes(0)) {
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { /* Binary attachments use the ACP base64 representation or a local file. */ }
    }
    if (text !== undefined) return [{ type: "resource", resource: { uri, mimeType, text } }];
    if (!localFiles) return [{ type: "resource", resource: { uri, mimeType, blob: data } }];

    const path = await localFiles.stage(name, bytes);
    return [
      { type: "resource_link", uri: pathToFileURL(path).href, name, mimeType },
      { type: "text", text: `Attached file ${JSON.stringify(name)} is available at ${JSON.stringify(path)}.` },
    ];
  }));
  return blocks.flat();
}

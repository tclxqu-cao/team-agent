import { MAX_PROMPT_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENTS, readPromptAttachments, type PromptAttachment } from "../../../core/src/domain/session/PromptAttachment";

export async function encodePromptAttachments(files: readonly File[], encode: (file: File) => Promise<string>): Promise<PromptAttachment[] | undefined> {
  if (!files.length) return undefined;
  if (files.length > MAX_PROMPT_ATTACHMENTS) throw new Error(`每条消息最多发送 ${MAX_PROMPT_ATTACHMENTS} 个文件`);
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_PROMPT_ATTACHMENT_BYTES) throw new Error("每条消息的文件附件总大小不能超过 8 MB");
  const attachments = await Promise.all(files.map(async file => {
    const url = await encode(file);
    return { name: file.name, mimeType: file.type || "application/octet-stream", data: url.slice(url.indexOf(",") + 1) };
  }));
  return readPromptAttachments(attachments);
}

export function promptAttachmentFiles(attachments: readonly PromptAttachment[]): File[] {
  return attachments.map(attachment => new File(
    [Uint8Array.from(atob(attachment.data), character => character.charCodeAt(0))],
    attachment.name, { type: attachment.mimeType },
  ));
}

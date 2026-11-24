/** File bytes selected by the user, carried inline with a prompt and its queue entry. */
export interface PromptAttachment {
  name: string;
  mimeType: string;
  data: string;
}

export const MAX_PROMPT_ATTACHMENTS = 8;
export const MAX_PROMPT_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export class InvalidPromptAttachmentError extends Error {}

export function readPromptAttachments(value: unknown): PromptAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PROMPT_ATTACHMENTS) {
    throw new InvalidPromptAttachmentError(`每条消息最多发送 ${MAX_PROMPT_ATTACHMENTS} 个文件`);
  }
  let bytes = 0;
  return value.map(entry => {
    const { name, mimeType, data } = entry && typeof entry === "object" ? entry as Partial<PromptAttachment> : {};
    if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\\\/\x00-\x1f]/.test(name) || name === "." || name === ".."
      || typeof mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)
      || typeof data !== "string" || data.length > Math.ceil(MAX_PROMPT_ATTACHMENT_BYTES / 3) * 4
      || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new InvalidPromptAttachmentError("消息包含无效的文件附件");
    }
    bytes += data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (bytes > MAX_PROMPT_ATTACHMENT_BYTES) throw new InvalidPromptAttachmentError("每条消息的文件附件总大小不能超过 8 MB");
    return { name, mimeType, data };
  });
}

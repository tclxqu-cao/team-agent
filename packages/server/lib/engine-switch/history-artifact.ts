import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveNativeRuntimeDirectory } from "@agent/native-runtime";
import type { Message } from "@agent/core";

/** Durable, readable recovery path for context omitted from the native prompt. */
export async function materializeEngineHistory(input: { id: string; messages: Message[]; workStateText: string }): Promise<string> {
  if (!/^[a-zA-Z0-9-]+$/.test(input.id)) throw new Error("Invalid handoff artifact id");
  const directory = join(resolveNativeRuntimeDirectory(), ".agent-data", "engine-handoffs", input.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const items = [];
  for (const [index, message] of input.messages.entries()) {
    const images = [...new Set([...(message.images ?? []), ...(message.presentation?.attachments ?? [])
      .flatMap((attachment) => attachment.dataUrl ? [attachment.dataUrl] : [])])];
    const imageFiles = [];
    for (const [imageIndex, data] of images.entries()) {
      const match = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([\s\S]+)$/.exec(data);
      if (!match) throw new Error("交接图片格式无法保存");
      const path = join(directory, `${index}-${imageIndex}.${match[1]}`);
      await writeFile(path, Buffer.from(match[2], "base64"), { mode: 0o600 });
      imageFiles.push(path);
    }
    items.push({ historyId: message.historyId, role: message.role, content: message.content,
      toolCalls: message.toolCalls, toolCallId: message.toolCallId, isError: message.isError, imageFiles });
  }
  const path = join(directory, "history.json");
  await writeFile(path, JSON.stringify({ workState: input.workStateText, items }, null, 2), { mode: 0o600 });
  return path;
}

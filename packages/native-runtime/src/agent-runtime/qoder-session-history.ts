import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Message } from "@agent/core";
import { nativeRecord } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import { RuntimeSessionError } from "./types.js";

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).join("");
  const part = nativeRecord(value);
  return typeof part.text === "string" ? part.text : part.content ? textContent(part.content) : "";
}

export function decodeQoderHistory(rows: NativeJsonPacket[], sessionId: string): Message[] {
  const nodes = new Map<string, NativeJsonPacket>();
  let leaf: string | undefined;
  let selected = false;
  for (const row of rows) {
    if (typeof row.sessionId === "string" && row.sessionId !== sessionId) continue;
    if (typeof row.uuid === "string") nodes.set(row.uuid, row);
    if (row.type === "active-leaf" && (typeof row.leafUuid === "string" || row.leafUuid === null)) {
      selected = true;
      leaf = typeof row.leafUuid === "string" ? row.leafUuid : undefined;
    }
  }
  if (!selected) {
    for (const row of nodes.values()) {
      if ((row.type === "user" || row.type === "assistant") && !row.isSidechain) leaf = String(row.uuid);
    }
  }
  if (leaf && !nodes.has(leaf)) throw new RuntimeSessionError("Qoder history has an unknown active leaf", "NATIVE_PROTOCOL_ERROR");
  const branch: NativeJsonPacket[] = [];
  const seen = new Set<string>();
  while (leaf) {
    if (seen.has(leaf)) throw new RuntimeSessionError("Qoder history contains a parent cycle", "NATIVE_PROTOCOL_ERROR");
    seen.add(leaf);
    const row = nodes.get(leaf);
    if (!row) break;
    branch.push(row);
    leaf = typeof row.parentUuid === "string" ? row.parentUuid : undefined;
  }

  const messages: Message[] = [];
  // Attachments also participate in the parent chain, but are not conversation turns.
  for (const row of branch.reverse()) {
    if (row.type !== "user" && row.type !== "assistant") continue;
    if (row.type === "user" && (row.isMeta === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true)) continue;
    const content = nativeRecord(row.message).content;
    const parts = Array.isArray(content) ? content.map(nativeRecord) : [];
    const text = typeof content === "string" ? content : parts.filter(part => part.type === "text").map(part => textContent(part)).join(row.type === "user" ? "\n" : "");
    const reasoning = parts.flatMap((part, index) => part.type === "thinking" && typeof part.thinking === "string" && part.thinking
      ? [{ itemId: `${row.uuid}:thinking:${index}`, sectionIndex: 0, text: part.thinking }] : []);
    const toolCalls = parts.filter(part => part.type === "tool_use" && typeof part.id === "string")
      .map(part => ({ id: String(part.id), name: String(part.name ?? "Qoder tool"), arguments: nativeRecord(part.input) }));
    if (text || reasoning.length || toolCalls.length) {
      messages.push({ role: row.type, content: text, historyId: String(row.uuid),
        ...(reasoning.length ? { presentation: { reasoning } } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
    }
    for (const part of parts) {
      if (part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
      messages.push({ role: "tool", content: textContent(part.content), toolCallId: part.tool_use_id,
        historyId: `${row.uuid}:tool:${part.tool_use_id}`, isError: part.is_error === true });
    }
  }
  return messages;
}

/** Native JSONL is authoritative; ACP session/load streams history beyond its RPC response. */
export class QoderSessionHistory {
  constructor(private readonly root = join(homedir(), ".qoder", "projects")) {}

  private async rows(path: string): Promise<NativeJsonPacket[]> {
    const info = await stat(path);
    if (info.size > 128 * 1024 * 1024) throw new RuntimeSessionError("Qoder transcript exceeds the safe read limit", "OPERATION_NOT_SUPPORTED");
    const input = createReadStream(path);
    const reader = createInterface({ input, crlfDelay: Infinity });
    const rows: NativeJsonPacket[] = [];
    try {
      for await (const line of reader) {
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new RuntimeSessionError("Qoder transcript line exceeds the safe read limit", "NATIVE_PROTOCOL_ERROR");
        if (!line.trim()) continue;
        try { rows.push(nativeRecord(JSON.parse(line))); }
        catch { /* A native writer may not have committed the final JSONL record yet. */ }
      }
    } finally { reader.close(); input.destroy(); }
    return rows;
  }

  async read(id: string): Promise<Message[]> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new RuntimeSessionError("Qoder session not found", "SESSION_NOT_FOUND");
    const directories = await readdir(this.root, { withFileTypes: true }).catch(error => {
      if (nativeRecord(error).code === "ENOENT") return [];
      throw error;
    });
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      try { return decodeQoderHistory(await this.rows(join(this.root, directory.name, `${id}.jsonl`)), id); }
      catch (error) { if (nativeRecord(error).code !== "ENOENT") throw error; }
    }
    throw new RuntimeSessionError("Qoder session not found", "SESSION_NOT_FOUND");
  }
}

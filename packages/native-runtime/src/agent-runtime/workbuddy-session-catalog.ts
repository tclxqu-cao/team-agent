import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Message } from "@agent/core";
import { nativeRecord } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { NativeProtocolSession } from "./stdio-native-runtime-adapter.js";
import { RuntimeSessionError } from "./types.js";

export function workBuddyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(workBuddyText).join("");
  const row = nativeRecord(value);
  return typeof row.text === "string" ? row.text : row.content ? workBuddyText(row.content) : "";
}

function argumentsRecord(value: unknown): NativeJsonPacket {
  if (typeof value !== "string") return nativeRecord(value);
  try { return nativeRecord(JSON.parse(value)); } catch { return {}; }
}

export function decodeWorkBuddyHistory(rows: NativeJsonPacket[]): Message[] {
  const messages: Message[] = [];
  const latest = new Map<string, NativeJsonPacket>();
  for (const [index, row] of rows.entries()) {
    // Older native logs share a response ID across text and parallel tool calls.
    const identity = (row.type === "function_call" || row.type === "function_call_result") && typeof row.callId === "string"
      ? [row.type, row.callId] : typeof row.id === "string" ? [row.type, row.id] : ["row", index];
    latest.set(JSON.stringify(identity), row);
  }
  // Replacing an existing Map value preserves its original transcript position.
  for (const row of latest.values()) {
    if (row.type === "message" && (row.role === "user" || row.role === "assistant" || row.role === "system")) {
      messages.push({ role: row.role, content: workBuddyText(row.content), historyId: typeof row.id === "string" ? row.id : undefined });
    } else if (row.type === "function_call" && typeof row.callId === "string") {
      messages.push({ role: "assistant", content: "", toolCalls: [{ id: row.callId, name: String(row.name ?? "WorkBuddy tool"), arguments: argumentsRecord(row.arguments) }] });
    } else if (row.type === "function_call_result" && typeof row.callId === "string") {
      const output = nativeRecord(row.output);
      messages.push({ role: "tool", toolCallId: row.callId, content: workBuddyText(row.output) || String(output.result ?? ""), isError: row.status === "error" || output.isError === true });
    } else if (row.type === "reasoning") {
      const text = workBuddyText(row.content);
      if (text) messages.push({ role: "assistant", content: "", presentation: { reasoning: [{ itemId: String(row.id ?? `reasoning-${messages.length}`), sectionIndex: 0, text }] } });
    }
  }
  return messages;
}

/** Read-only projection of WorkBuddy-owned JSONL; no mirrored transcript or credential store. */
export class WorkBuddySessionCatalog {
  private readonly files = new Map<string, string>();
  private readonly cache = new Map<string, { stamp: string; session: NativeProtocolSession }>();
  constructor(private readonly root = process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || join(homedir(), ".workbuddy")) {}

  private async rows(path: string): Promise<NativeJsonPacket[]> {
    const info = await stat(path);
    if (info.size > 128 * 1024 * 1024) throw new RuntimeSessionError("WorkBuddy transcript exceeds the safe read limit", "OPERATION_NOT_SUPPORTED");
    const input = createReadStream(path);
    const reader = createInterface({ input, crlfDelay: Infinity });
    const rows: NativeJsonPacket[] = [];
    try {
      for await (const line of reader) {
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new RuntimeSessionError("WorkBuddy transcript line exceeds the safe read limit", "NATIVE_PROTOCOL_ERROR");
        if (!line.trim()) continue;
        try { rows.push(nativeRecord(JSON.parse(line))); }
        catch { /* A live native writer may not have committed the last line yet. */ }
      }
    } finally { reader.close(); input.destroy(); }
    return rows;
  }

  private summary(id: string, rows: NativeJsonPacket[], fallback: Date): NativeProtocolSession {
    const first = rows.find(row => typeof row.timestamp === "number" || typeof row.timestamp === "string");
    const last = [...rows].reverse().find(row => typeof row.timestamp === "number" || typeof row.timestamp === "string");
    const cwd = rows.find(row => typeof row.cwd === "string")?.cwd;
    const title = [...rows].reverse().find(row => row.type === "ai-title" && typeof row.aiTitle === "string")?.aiTitle;
    const prompt = rows.find(row => row.type === "message" && row.role === "user");
    const date = (value: unknown) => {
      const result = new Date(typeof value === "number" || typeof value === "string" ? value : fallback);
      return Number.isFinite(result.getTime()) ? result.toISOString() : fallback.toISOString();
    };
    return { id, title: typeof title === "string" ? title : workBuddyText(prompt?.content).slice(0, 120) || "WorkBuddy",
      cwd: typeof cwd === "string" ? cwd : "", created: date(first?.timestamp), updated: date(last?.timestamp) };
  }

  async list(): Promise<NativeProtocolSession[]> {
    const projects = join(this.root, "projects");
    const directories = await readdir(projects, { withFileTypes: true }).catch(error => {
      if (nativeRecord(error).code === "ENOENT") return [];
      throw error;
    });
    const found = new Set<string>();
    const sessions: NativeProtocolSession[] = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      for (const file of await readdir(join(projects, directory.name), { withFileTypes: true })) {
        if (!file.isFile() || !/^[a-zA-Z0-9_-]+\.jsonl$/.test(file.name)) continue;
        const id = file.name.slice(0, -6);
        const path = join(projects, directory.name, file.name);
        const info = await stat(path);
        const stamp = `${info.mtimeMs}:${info.size}`;
        const cached = this.cache.get(path);
        const session = cached?.stamp === stamp ? cached.session : this.summary(id, await this.rows(path), info.mtime);
        this.cache.set(path, { stamp, session }); this.files.set(id, path); found.add(id);
        sessions.push({ ...session });
      }
    }
    for (const id of this.files.keys()) if (!found.has(id)) this.files.delete(id);
    const writers = await readdir(join(this.root, "sessions")).catch(() => []);
    for (const filename of writers) {
      if (!/^\d+\.json$/.test(filename)) continue;
      let writer: NativeJsonPacket;
      try { writer = nativeRecord(JSON.parse(await readFile(join(this.root, "sessions", filename), "utf8"))); } catch { continue; }
      if (typeof writer.pid !== "number") continue;
      try { process.kill(writer.pid, 0); } catch (error) { if (nativeRecord(error).code !== "EPERM") continue; }
      const session = sessions.find(row => row.id === writer.sessionId);
      if (session) session.running = true;
    }
    return sessions.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  async read(id: string) {
    const session = (await this.list()).find(row => row.id === id);
    const path = this.files.get(id);
    if (!session || !path) throw new RuntimeSessionError("WorkBuddy session not found", "SESSION_NOT_FOUND");
    return { session, messages: decodeWorkBuddyHistory(await this.rows(path)) };
  }
}

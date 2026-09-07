import { open, type FileHandle } from "node:fs/promises";

export type CodexRolloutActivity = "running" | "idle" | "unknown";

export interface CodexRolloutFinalAnswer {
  turnId: string;
  itemId?: string;
  text: string;
}

interface ActivityCacheEntry {
  identity: string;
  size: number;
  mtimeMs: number;
  trailing: Buffer;
  trailingOverflow: boolean;
  activity: CodexRolloutActivity;
}

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED_LINE_BYTES = 256 * 1024;
const MAX_FINAL_ANSWER_LOOKBACK_BYTES = 1024 * 1024;
const START_EVENTS = new Set(["task_started", "turn_started"]);
const TERMINAL_EVENTS = new Set(["task_complete", "turn_complete", "turn_aborted"]);

export function codexRolloutActivityFromLine(line: Buffer | string): CodexRolloutActivity {
  const text = typeof line === "string" ? line : line.toString("utf8");
  if (!text.trim()) return "unknown";
  try {
    const record = JSON.parse(text) as {
      type?: unknown;
      payload?: { type?: unknown };
    };
    if (record.type !== "event_msg" || typeof record.payload?.type !== "string") {
      return "unknown";
    }
    if (START_EVENTS.has(record.payload.type)) return "running";
    if (TERMINAL_EVENTS.has(record.payload.type)) return "idle";
  } catch {
    // A writer can leave an incomplete final JSONL record between file events.
  }
  return "unknown";
}

/**
 * Reads only the rollout tail and returns a final answer that is newer than
 * the latest start/terminal boundary. This covers the short interval where
 * the final response_item is durable but task_complete has not arrived yet.
 */
export async function readCodexRolloutFinalizingAnswer(
  path: string,
  maxBytes = MAX_FINAL_ANSWER_LOOKBACK_BYTES,
): Promise<CodexRolloutFinalAnswer | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size === 0) return null;
    const length = Math.min(metadata.size, Math.max(1, maxBytes));
    const start = metadata.size - length;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const afterRead = await handle.stat();
    if (afterRead.size !== metadata.size || afterRead.ino !== metadata.ino) return null;
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const signal = codexRolloutTailSignalFromLine(lines[index]);
      if (signal.boundary) return null;
      if (signal.finalAnswer) return signal.finalAnswer;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function codexRolloutTailSignalFromLine(line: string): {
  boundary: boolean;
  finalAnswer: CodexRolloutFinalAnswer | null;
} {
  if (!line.trim()) return { boundary: false, finalAnswer: null };
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    const payload = asRecord(record.payload);
    if (record.type === "event_msg" && typeof payload.type === "string") {
      if (START_EVENTS.has(payload.type) || TERMINAL_EVENTS.has(payload.type)) {
        return { boundary: true, finalAnswer: null };
      }
      if (payload.type === "item_completed") {
        return { boundary: false, finalAnswer: finalAnswerFromItem(payload.item, payload.turn_id) };
      }
    }
    if (record.type === "response_item") {
      return { boundary: false, finalAnswer: finalAnswerFromItem(payload, payload.turn_id) };
    }
  } catch {
    // A writer can leave an incomplete final JSONL record between file events.
  }
  return { boundary: false, finalAnswer: null };
}

function finalAnswerFromItem(value: unknown, fallbackTurnId: unknown): CodexRolloutFinalAnswer | null {
  const item = asRecord(value);
  const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
  const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
  if ((type !== "agentmessage" && type !== "message") || (role && role !== "assistant")) return null;
  if (item.phase !== "final_answer") return null;
  const turnId = asString(asRecord(item.internal_chat_message_metadata_passthrough).turn_id)
    || asString(item.turn_id)
    || asString(fallbackTurnId);
  if (!turnId) return null;
  const text = Array.isArray(item.content)
    ? item.content.flatMap((entry) => {
        const part = asRecord(entry);
        const partType = typeof part.type === "string" ? part.type.toLowerCase() : "";
        return (partType === "text" || partType === "output_text") && typeof part.text === "string"
          ? [part.text]
          : [];
      }).join("")
    : "";
  if (!text.trim()) return null;
  return {
    turnId,
    ...(typeof item.id === "string" ? { itemId: item.id } : {}),
    text,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class CodexRolloutActivityReader {
  private readonly cache = new Map<string, ActivityCacheEntry>();

  constructor(private readonly chunkSize = DEFAULT_CHUNK_SIZE) {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error("Codex rollout activity chunk size must be a positive integer");
    }
  }

  async read(path: string): Promise<CodexRolloutActivity> {
    let handle: FileHandle | null = null;
    try {
      handle = await open(path, "r");
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        this.cache.delete(path);
        return "unknown";
      }

      const identity = `${metadata.dev}:${metadata.ino}`;
      const cached = this.cache.get(path);
      const canContinue = cached
        && cached.identity === identity
        && metadata.size >= cached.size
        && (metadata.size > cached.size || metadata.mtimeMs === cached.mtimeMs);
      const next = canContinue
        ? await this.readAppended(handle, cached, metadata.size, metadata.mtimeMs)
        : await this.bootstrap(handle, identity, metadata.size, metadata.mtimeMs);
      this.cache.set(path, next);
      return next.activity;
    } catch {
      this.cache.delete(path);
      return "unknown";
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async readMany(paths: Iterable<string>): Promise<Map<string, CodexRolloutActivity>> {
    const requested = [...new Set(paths)];
    const requestedSet = new Set(requested);
    for (const cachedPath of this.cache.keys()) {
      if (!requestedSet.has(cachedPath)) this.cache.delete(cachedPath);
    }
    const activities = await Promise.all(requested.map(async (path) => [
      path,
      await this.read(path),
    ] as const));
    return new Map(activities);
  }

  private async bootstrap(
    handle: FileHandle,
    identity: string,
    size: number,
    mtimeMs: number,
  ): Promise<ActivityCacheEntry> {
    let cursor = size;
    let newerFragment: Buffer<ArrayBufferLike> | null = Buffer.alloc(0);
    let activity: CodexRolloutActivity = "unknown";
    let trailing: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let trailingOverflow = false;
    let trailingResolved = false;

    while (cursor > 0 && activity === "unknown") {
      const length = Math.min(this.chunkSize, cursor);
      cursor -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, cursor);
      const content = chunk.subarray(0, bytesRead);
      const newlineIndexes = findNewlineIndexes(content);

      if (newlineIndexes.length === 0) {
        newerFragment = prependBounded(content, newerFragment);
      } else {
        let segmentEnd = content.length;
        for (let index = newlineIndexes.length - 1; index >= 0; index -= 1) {
          const newlineIndex = newlineIndexes[index];
          const segment = trimTrailingCarriageReturn(content.subarray(newlineIndex + 1, segmentEnd));
          const line = prependBounded(segment, newerFragment);
          if (!trailingResolved) {
            trailing = line ?? Buffer.alloc(0);
            trailingOverflow = line === null;
            trailingResolved = true;
          }
          if (line) activity = codexRolloutActivityFromLine(line);
          if (activity !== "unknown") break;
          newerFragment = Buffer.alloc(0);
          segmentEnd = newlineIndex;
        }
        if (activity === "unknown") {
          newerFragment = Buffer.from(content.subarray(0, segmentEnd));
        }
      }
    }

    if (activity === "unknown" && cursor === 0 && newerFragment) {
      if (!trailingResolved) {
        trailing = newerFragment;
        trailingResolved = true;
      }
      activity = codexRolloutActivityFromLine(newerFragment);
    }
    if (!trailingResolved) trailingOverflow = newerFragment === null;

    return { identity, size, mtimeMs, trailing, trailingOverflow, activity };
  }

  private async readAppended(
    handle: FileHandle,
    cached: ActivityCacheEntry,
    size: number,
    mtimeMs: number,
  ): Promise<ActivityCacheEntry> {
    if (size === cached.size) return { ...cached, mtimeMs };

    let cursor = cached.size;
    let trailing = cached.trailing;
    let trailingOverflow = cached.trailingOverflow;
    let activity = cached.activity;
    while (cursor < size) {
      const length = Math.min(this.chunkSize, size - cursor);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, cursor);
      if (bytesRead === 0) break;
      cursor += bytesRead;
      const content = chunk.subarray(0, bytesRead);
      let segmentStart = 0;
      for (const newlineIndex of findNewlineIndexes(content)) {
        const segment = trimTrailingCarriageReturn(content.subarray(segmentStart, newlineIndex));
        const line = trailingOverflow ? null : appendBounded(trailing, segment);
        if (line) {
          const next = codexRolloutActivityFromLine(line);
          if (next !== "unknown") activity = next;
        }
        trailing = Buffer.alloc(0);
        trailingOverflow = false;
        segmentStart = newlineIndex + 1;
      }
      const remainder = content.subarray(segmentStart);
      const nextTrailing = trailingOverflow ? null : appendBounded(trailing, remainder);
      trailing = nextTrailing ?? Buffer.alloc(0);
      trailingOverflow = nextTrailing === null;
    }

    if (!trailingOverflow) {
      const trailingActivity = codexRolloutActivityFromLine(trailing);
      if (trailingActivity !== "unknown") activity = trailingActivity;
    }
    return { ...cached, size: cursor, mtimeMs, trailing, trailingOverflow, activity };
  }
}

function findNewlineIndexes(input: Buffer): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === 0x0a) indexes.push(index);
  }
  return indexes;
}

function prependBounded(prefix: Buffer, suffix: Buffer | null): Buffer | null {
  if (!suffix || prefix.length + suffix.length > MAX_BUFFERED_LINE_BYTES) return null;
  if (prefix.length === 0) return suffix;
  if (suffix.length === 0) return Buffer.from(prefix);
  return Buffer.concat([prefix, suffix], prefix.length + suffix.length);
}

function appendBounded(prefix: Buffer, suffix: Buffer): Buffer | null {
  if (prefix.length + suffix.length > MAX_BUFFERED_LINE_BYTES) return null;
  if (suffix.length === 0) return prefix;
  if (prefix.length === 0) return Buffer.from(suffix);
  return Buffer.concat([prefix, suffix], prefix.length + suffix.length);
}

function trimTrailingCarriageReturn(input: Buffer): Buffer {
  return input.at(-1) === 0x0d ? input.subarray(0, -1) : input;
}

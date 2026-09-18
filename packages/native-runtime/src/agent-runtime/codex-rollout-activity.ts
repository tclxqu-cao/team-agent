import { open, type FileHandle } from "node:fs/promises";

export type CodexRolloutActivity = "running" | "idle" | "unknown";

export interface CodexRolloutFinalAnswer {
  turnId: string;
  itemId?: string;
  text: string;
}

export interface CodexRolloutCommentary {
  turnId: string;
  itemId?: string;
  text: string;
}

export interface CodexRolloutCommentarySnapshot {
  commentary: CodexRolloutCommentary[];
  itemOrder: string[];
}

interface CommentaryTurnCache {
  commentary: Map<string, CodexRolloutCommentary>;
  itemOrder: string[];
  itemIds: Set<string>;
}

interface CommentaryCacheEntry {
  identity: string;
  size: number;
  mtimeMs: number;
  trailing: Buffer;
  trailingOverflow: boolean;
  turns: Map<string, CommentaryTurnCache>;
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
  const text = agentMessageText(item);
  if (!text.trim()) return null;
  return {
    turnId,
    ...(typeof item.id === "string" ? { itemId: item.id } : {}),
    text,
  };
}

function agentMessageText(item: Record<string, unknown>): string {
  return Array.isArray(item.content)
    ? item.content.flatMap((entry) => {
        const part = asRecord(entry);
        const partType = typeof part.type === "string" ? part.type.toLowerCase() : "";
        return (partType === "text" || partType === "output_text") && typeof part.text === "string"
          ? [part.text]
          : [];
      }).join("")
    : typeof item.text === "string" ? item.text : "";
}

export class CodexRolloutCommentaryReader {
  private readonly cache = new Map<string, CommentaryCacheEntry>();

  constructor(private readonly chunkSize = DEFAULT_CHUNK_SIZE) {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error("Codex rollout commentary chunk size must be a positive integer");
    }
  }

  async read(path: string, turnId: string): Promise<CodexRolloutCommentarySnapshot> {
    let handle: FileHandle | null = null;
    try {
      handle = await open(path, "r");
      const metadata = await handle.stat();
      if (!metadata.isFile()) return { commentary: [], itemOrder: [] };
      const identity = `${metadata.dev}:${metadata.ino}`;
      const previous = this.cache.get(path);
      const canContinue = previous
        && previous.identity === identity
        && metadata.size >= previous.size
        && (metadata.size > previous.size || metadata.mtimeMs === previous.mtimeMs);
      const entry = canContinue
        ? previous
        : {
            identity,
            size: 0,
            mtimeMs: metadata.mtimeMs,
            trailing: Buffer.alloc(0),
            trailingOverflow: false,
            turns: new Map<string, CommentaryTurnCache>(),
          };
      await this.readAppendedCommentary(handle, entry, metadata.size);
      entry.size = metadata.size;
      entry.mtimeMs = metadata.mtimeMs;
      this.cache.set(path, entry);
      if (this.cache.size > 64) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      const turn = entry.turns.get(turnId);
      return turn
        ? { commentary: [...turn.commentary.values()], itemOrder: [...turn.itemOrder] }
        : { commentary: [], itemOrder: [] };
    } catch {
      this.cache.delete(path);
      return { commentary: [], itemOrder: [] };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readAppendedCommentary(
    handle: FileHandle,
    entry: CommentaryCacheEntry,
    targetSize: number,
  ): Promise<void> {
    let offset = entry.size;
    while (offset < targetSize) {
      const length = Math.min(this.chunkSize, targetSize - offset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      let content = chunk.subarray(0, bytesRead);
      if (entry.trailingOverflow) {
        const newline = content.indexOf(0x0a);
        if (newline < 0) continue;
        content = content.subarray(newline + 1);
        entry.trailingOverflow = false;
      } else if (entry.trailing.length > 0) {
        content = Buffer.concat([entry.trailing, content]);
      }

      const lastNewline = content.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        entry.trailing = content.length <= MAX_BUFFERED_LINE_BYTES ? Buffer.from(content) : Buffer.alloc(0);
        entry.trailingOverflow = content.length > MAX_BUFFERED_LINE_BYTES;
        continue;
      }
      const complete = content.subarray(0, lastNewline).toString("utf8").split("\n");
      for (const line of complete) this.consumeCommentaryLine(entry, line);
      const trailing = content.subarray(lastNewline + 1);
      entry.trailing = trailing.length <= MAX_BUFFERED_LINE_BYTES ? Buffer.from(trailing) : Buffer.alloc(0);
      entry.trailingOverflow = trailing.length > MAX_BUFFERED_LINE_BYTES;
    }
  }

  private consumeCommentaryLine(entry: CommentaryCacheEntry, line: string): void {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const payload = asRecord(record.payload);
      let item: Record<string, unknown>;
      let fallbackTurnId: unknown;
      if (record.type === "response_item") {
        item = payload;
        fallbackTurnId = payload.turn_id;
      } else if (record.type === "event_msg" && payload.type === "item_completed") {
        item = asRecord(payload.item);
        fallbackTurnId = payload.turn_id;
      } else {
        return;
      }
      const turnId = asString(asRecord(item.internal_chat_message_metadata_passthrough).turn_id)
        || asString(item.turn_id)
        || asString(fallbackTurnId);
      if (!turnId) return;
      let turn = entry.turns.get(turnId);
      if (!turn) {
        turn = { commentary: new Map(), itemOrder: [], itemIds: new Set() };
        entry.turns.set(turnId, turn);
      }
      const itemId = asString(item.id);
      if (itemId && !turn.itemIds.has(itemId)) {
        turn.itemIds.add(itemId);
        turn.itemOrder.push(itemId);
      }
      const type = asString(item.type).toLowerCase();
      const role = asString(item.role).toLowerCase();
      if (
        item.phase !== "commentary"
        || (type !== "agentmessage" && type !== "message")
        || (role && role !== "assistant")
      ) return;
      const text = agentMessageText(item);
      if (!text.trim()) return;
      const key = itemId || `text:${text}`;
      turn.commentary.set(key, {
        turnId,
        ...(itemId ? { itemId } : {}),
        text,
      });
    } catch {
      // Writers can leave an incomplete final JSONL record between file events.
    }
  }
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

import type { Message } from "../model/entities.js";
import type { SessionQueryIndex } from "./entities.js";

const ANCHOR_PREFIX = "history-anchor.v1.";
const MESSAGE_PREFIX = "history-message.v1.";
const PREVIEW_LIMIT = 120;

export class StaleSessionAnchorError extends Error {
  readonly code = "STALE_SESSION_ANCHOR";

  constructor() {
    super("Session history changed; refresh the query index");
    this.name = "StaleSessionAnchorError";
  }
}

export function buildSessionQueryIndex(
  sessionId: string,
  messages: readonly Message[],
  revision = computeSessionHistoryRevision(messages),
): SessionQueryIndex {
  const visible = visibleSessionMessages(messages);
  let ordinal = 0;
  const entries = visible.flatMap(({ message, visibleIndex }) => {
    if (!isIndexedUserMessage(message)) return [];
    ordinal += 1;
    return [{
      messageId: sessionHistoryMessageId(visibleIndex, message),
      ordinal,
      preview: queryPreview(message),
      pageToken: encodeSessionHistoryAnchor(revision, visibleIndex),
    }];
  });
  return { sessionId, revision, totalQueries: entries.length, entries };
}

export function computeSessionHistoryRevision(messages: readonly Message[]): string {
  let hash = 0x811c9dc5;
  const visible = messages.filter(isVisibleSessionMessage);
  hash = hashText(hash, String(visible.length));
  for (const message of visible) {
    const content = message.content ?? "";
    const signature = [
      message.role,
      message.name ?? "",
      String(content.length),
      content.slice(0, message.role === "user" ? 128 : 96),
      content.slice(message.role === "user" ? -32 : -96),
      String(message.images?.length ?? message.presentation?.attachments?.length ?? 0),
      (message.toolCalls ?? []).map((call) => call.id).join(","),
    ].join("\u001f");
    hash = hashText(hash, signature);
  }
  return `${visible.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

export function sessionHistoryMessageId(visibleIndex: number, message: Message): string {
  const content = message.content ?? "";
  const signature = [
    message.role,
    message.name ?? "",
    String(content.length),
    content.slice(0, 128),
    content.slice(-32),
    String(message.images?.length ?? message.presentation?.attachments?.length ?? 0),
  ].join("\u001f");
  return `${MESSAGE_PREFIX}${visibleIndex.toString(36)}.${(hashText(0x811c9dc5, signature) >>> 0).toString(36)}`;
}

export function encodeSessionHistoryAnchor(revision: string, visibleIndex: number): string {
  return `${ANCHOR_PREFIX}${revision}.${visibleIndex.toString(36)}`;
}

export function decodeSessionHistoryAnchor(token: string, revision: string): number {
  if (!token.startsWith(ANCHOR_PREFIX)) throw new StaleSessionAnchorError();
  const payload = token.slice(ANCHOR_PREFIX.length);
  const separator = payload.lastIndexOf(".");
  if (separator <= 0 || payload.slice(0, separator) !== revision) {
    throw new StaleSessionAnchorError();
  }
  const visibleIndex = Number.parseInt(payload.slice(separator + 1), 36);
  if (!Number.isSafeInteger(visibleIndex) || visibleIndex < 0) {
    throw new StaleSessionAnchorError();
  }
  return visibleIndex;
}

export function visibleSessionMessages(
  messages: readonly Message[],
): Array<{ message: Message; visibleIndex: number }> {
  const visible: Array<{ message: Message; visibleIndex: number }> = [];
  for (const message of messages) {
    if (!isVisibleSessionMessage(message)) continue;
    visible.push({ message, visibleIndex: visible.length });
  }
  return visible;
}

function isVisibleSessionMessage(message: Message): boolean {
  return message.role === "user" || message.role === "assistant";
}

function isIndexedUserMessage(message: Message): boolean {
  if (message.role !== "user") return false;
  if (message.name === "__interrupt__" || message.name === "__compaction_checkpoint__") return false;
  return Boolean(
    message.content.trim()
    || message.images?.length
    || message.presentation?.attachments?.some((attachment) => attachment.type === "image"),
  );
}

function queryPreview(message: Message): string {
  const text = message.content.replace(/\s+/g, " ").trim();
  if (text) return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT - 1)}…` : text;
  return "图片消息";
}

function hashText(seed: number, value: string): number {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

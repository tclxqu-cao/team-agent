import {
  cleanEngineHistory, decodeSessionHistoryAnchor, encodeSessionHistoryAnchor,
  historyDeltaStart, scopedHistory, StaleSessionAnchorError,
  type EngineSwitchRecord, type Message, type SessionHistoryQuery, type SessionQueryIndex,
  type SessionToolResultRef,
} from "@agent/core";
import { getEngineSwitchContainer } from "./container";
import { getNativeRuntimeService } from "../native-runtime-service";
import { getEngineHistoryStore } from "./history-store";

const CURSOR = "engine-history.v1.";
const nativeCursor = (ordinal: number) => `history.v1.${ordinal}`;
// Only tiny identity checks are cached; transcript pages and tool bodies are not.
const boundaryChecks = new Map<string, boolean>();
const queryPreviews = new Map<string, string>();
const limitOf = (limit?: number) => Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit!) : 50));
const visible = (message: Message) => message.role === "user" || message.role === "assistant";
const nativeStart = (detail: { history?: { olderCursor?: string | null; nextCursor?: string | null } }) => {
  const cursor = detail.history?.olderCursor ?? detail.history?.nextCursor;
  return cursor?.startsWith("history.v1.") ? Number(cursor.slice("history.v1.".length)) : 0;
};

interface Segment {
  record?: EngineSwitchRecord;
  sessionId: string;
  agentType: string;
  start: number;
  contentStart: number;
  end: number;
  count: number;
  boundaryUncertain: boolean;
}

/** Metadata + indexed immutable phases. Normal/prefetch reads never hydrate native full history. */
async function context(sessionId: string, limit = 1) {
  const ledger = getEngineSwitchContainer().ledger;
  const { thread, records } = ledger.ledger(sessionId, false);
  if (!thread) return null;
  const store = getEngineHistoryStore();
  const service = getNativeRuntimeService();
  for (const [index, record] of records.entries()) {
    if (store.info(record.id)) continue;
    const raw = store.raw(record.id);
    let messages = raw.phaseMessages;
    let uncertain = false;
    if (!messages) {
      let snapshot = raw.sourceSnapshot;
      if (!snapshot) {
        // One-time compatibility indexing only. Missing historical boundaries
        // remain explicitly uncertain; subsequent pages use the saved index.
        const source = await service.get(record.fromSessionId);
        const envelopes = records.flatMap((entry) => {
          const handoff = ledger.handoffForRecord(entry.id);
          return handoff ? [handoff] : [];
        });
        const all = cleanEngineHistory(source.messages, envelopes);
        const boundary = record.coveredThroughHistoryId ? all.findIndex((message) => message.historyId === record.coveredThroughHistoryId) : -1;
        snapshot = boundary >= 0 ? all.slice(0, boundary + 1) : all;
        uncertain = boundary < 0 && all.length > 0;
      }
      const previous = records.slice(0, index).reverse().find((entry) => entry.fromSessionId === record.fromSessionId);
      const previousSnapshot = previous ? store.raw(previous.id, true).sourceSnapshot ?? [] : [];
      messages = scopedHistory(snapshot, record.fromSessionId, historyDeltaStart(snapshot, previousSnapshot), record.id);
    }
    store.install(record, messages, uncertain, !raw.phaseMessages);
  }
  const active = await service.get(thread.currentSessionId, {
    limit, ...(thread.currentAgentType === "codex" ? { view: "core" as const } : {}),
  });
  const totalNative = active.history?.totalItems ?? active.messages.filter(visible).length;
  const previous = [...records].reverse().find((record) => record.fromSessionId === active.id);
  let boundary = 0;
  let activeUncertain = false;
  if (previous) {
    if (previous.sourceHistoryItemCount !== undefined && previous.sourceHistoryLastId) {
      const count = previous.sourceHistoryItemCount;
      if (count <= totalNative) {
        const key = JSON.stringify([active.id, previous.id, previous.sourceHistoryLastId, active.history?.revision]);
        let matches = active.history?.revision ? boundaryChecks.get(key) : undefined;
        if (matches === undefined) {
          // Validate an opaque native identity, never infer an ordinal from its suffix.
          let boundaryPage = active;
          if (count <= nativeStart(active) || count > nativeStart(active) + (active.history?.pageSize ?? 0)) {
            boundaryPage = await service.get(active.id, { before: nativeCursor(count), limit: 1,
              ...(active.agentType === "codex" ? { view: "core" as const } : {}) });
          }
          matches = boundaryPage.messages.some((message) => message.historyId === previous.sourceHistoryLastId);
          if (active.history?.revision) {
            if (boundaryChecks.size >= 128) boundaryChecks.delete(boundaryChecks.keys().next().value!);
            boundaryChecks.set(key, matches);
          }
        }
        if (matches) boundary = count;
        else activeUncertain = true;
      } else activeUncertain = true;
    } else if (previous.sourceHistoryItemCount === 0) boundary = 0;
    else activeUncertain = true;
  }
  const segments: Segment[] = [];
  let offset = 0;
  const append = (session: string, agentType: string, count: number, uncertain: boolean, record?: EngineSwitchRecord) => {
    const markerCount = count > 0 ? Number(offset > 0) + Number(uncertain) : 0;
    segments.push({ record, sessionId: session, agentType, start: offset,
      contentStart: offset + markerCount, end: offset + markerCount + count,
      count, boundaryUncertain: uncertain });
    offset += markerCount + count;
  };
  for (const record of records) {
    const info = store.info(record.id)!;
    append(record.fromSessionId, record.fromAgentType, info.count, info.boundaryUncertain, record);
  }
  append(active.id, active.agentType, Math.max(0, totalNative - boundary), activeUncertain);
  const epoch = records.at(-1)!.id;
  const revision = `engine:${epoch}:${active.history?.revision ?? totalNative}:${boundary}`;
  return { thread, records, store, service, active, boundary, boundaryLastId: previous?.sourceHistoryLastId,
    segments, total: offset, epoch, revision };
}
type Context = NonNullable<Awaited<ReturnType<typeof context>>>;

function encodeCursor(ctx: Context, ordinal: number): string {
  return `${CURSOR}${encodeURIComponent(ctx.epoch)}.${ordinal}`;
}
function decodeCursor(ctx: Context, cursor: string | undefined, fallback: number): number {
  if (!cursor) return fallback;
  const prefix = `${CURSOR}${encodeURIComponent(ctx.epoch)}.`;
  if (!cursor.startsWith(prefix)) throw new StaleSessionAnchorError();
  const ordinal = Number(cursor.slice(prefix.length));
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new StaleSessionAnchorError();
  return Math.min(ordinal, ctx.total);
}
function boundaryStart(ctx: Context, nominal: number): number {
  const segment = ctx.segments.find((part) => nominal >= part.start && nominal < part.end);
  if (!segment?.record || nominal < segment.contentStart) return nominal;
  return segment.contentStart + ctx.store.boundaryStart(segment.record.id, nominal - segment.contentStart);
}
function boundaryEnd(ctx: Context, nominal: number): number {
  const segment = ctx.segments.find((part) => nominal >= part.contentStart && nominal < part.end);
  if (!segment?.record) return nominal;
  return segment.contentStart + ctx.store.boundaryEnd(segment.record.id, nominal - segment.contentStart, segment.count);
}
function markers(segment: Segment): Message[] {
  const messages: Message[] = [];
  if (!segment.count) return messages;
  if (segment.start > 0) messages.push({ role: "assistant", name: "__thread_switch__",
    historyId: `thread-switch:${segment.record?.id ?? "active"}:${segment.sessionId}`,
    content: `⟲ 已切换引擎 → ${segment.agentType}` });
  if (segment.boundaryUncertain) messages.push({ role: "assistant", name: "__thread_switch__",
    historyId: `thread-legacy:${segment.record?.id ?? "active"}:${segment.sessionId}`,
    content: "此段来自旧版或已变更的历史，无法确认原切换边界。" });
  return messages;
}
function detail(ctx: Context, messages: Message[], start: number, end: number, kind: "latest" | "anchored", events = ctx.active.events) {
  return { ...ctx.active, messages, events,
    history: { nextCursor: start > 0 ? encodeCursor(ctx, start) : null, hasMore: start > 0,
      olderCursor: start > 0 ? encodeCursor(ctx, start) : null,
      newerCursor: end < ctx.total ? encodeCursor(ctx, end) : null,
      totalItems: ctx.total, pageSize: end - start, kind, revision: ctx.revision,
      // Mixed threads can contain frozen Codex traces even while another engine owns the tail.
      delivery: "core" as const },
    threadKey: ctx.thread.threadKey, activeSessionId: ctx.thread.currentSessionId,
    segments: ctx.segments.map((segment) => ({ sessionId: segment.sessionId, agentType: segment.agentType,
      messageCount: segment.count, boundaryUncertain: segment.boundaryUncertain })),
  };
}

/** Only switched single-agent threads use this view. Ordinary reads stay native. */
export async function loadEngineThreadHistory(sessionId: string, query: SessionHistoryQuery = {}) {
  const limit = limitOf(query.limit);
  const ctx = await context(sessionId, query.view !== "trace" && !query.before && !query.after && !query.anchor ? limit : 1);
  if (!ctx) return null;
  if (query.view === "trace" && query.turnId) {
    if (query.revision !== ctx.revision) throw new StaleSessionAnchorError();
    const record = ctx.records.find((record) => query.turnId!.startsWith(`engine-frozen:${encodeURIComponent(record.id)}:`));
    if (record) return { ...detail(ctx, ctx.store.trace(record.id, query.turnId), 0, 0, "anchored", []),
      history: { ...detail(ctx, [], 0, 0, "anchored").history, delivery: "trace" as const } };
    const trace = await ctx.service.get(ctx.active.id, { view: "trace", turnId: query.turnId, revision: ctx.active.history?.revision });
    return { ...detail(ctx, trace.messages, 0, 0, "anchored", trace.events),
      history: { ...detail(ctx, [], 0, 0, "anchored").history, delivery: "trace" as const } };
  }
  let start: number, end: number;
  const kind = query.anchor || query.after ? "anchored" : "latest";
  const anchor = query.anchor ? decodeSessionHistoryAnchor(query.anchor, ctx.revision) : undefined;
  if (anchor !== undefined) {
    if (anchor >= ctx.total) throw new StaleSessionAnchorError();
    start = boundaryStart(ctx, Math.max(0, anchor - Math.floor(limit / 2)));
    end = boundaryEnd(ctx, Math.min(ctx.total, Math.max(start + limit, anchor + 1)));
  } else if (query.after) {
    start = decodeCursor(ctx, query.after, 0);
    end = boundaryEnd(ctx, Math.min(ctx.total, start + limit));
  } else {
    end = decodeCursor(ctx, query.before, ctx.total);
    start = boundaryStart(ctx, Math.max(0, end - limit));
  }
  const activeSegment = ctx.segments.at(-1)!;
  let activePage = ctx.active;
  let pageEvents = ctx.active.events;
  let activeMessages: Message[] = [];
  if (end > activeSegment.contentStart && activeSegment.count) {
    const nativeQuery: SessionHistoryQuery = { limit, ...(ctx.active.agentType === "codex" ? { view: "core" } : {}) };
    if (anchor !== undefined && anchor >= activeSegment.contentStart) nativeQuery.anchor = encodeSessionHistoryAnchor(ctx.active.history!.revision!, anchor - activeSegment.contentStart + ctx.boundary);
    else if (query.after && start >= activeSegment.contentStart) nativeQuery.after = nativeCursor(start - activeSegment.contentStart + ctx.boundary);
    else if (query.before || query.after || query.anchor) nativeQuery.before = nativeCursor(end - activeSegment.contentStart + ctx.boundary);
    if (query.before || query.after || query.anchor) activePage = await ctx.service.get(ctx.active.id, nativeQuery);
    if (activePage.history?.revision !== ctx.active.history?.revision) throw new StaleSessionAnchorError();
    const sourceStart = nativeStart(activePage);
    const sourceEnd = sourceStart + (activePage.history?.pageSize ?? activePage.messages.filter(visible).length);
    const actualStart = activeSegment.contentStart + Math.max(0, sourceStart - ctx.boundary);
    const actualEnd = activeSegment.contentStart + Math.max(0, sourceEnd - ctx.boundary);
    if (sourceStart > ctx.boundary) start = actualStart;
    // Include a phase separator when starting at the first active item.
    else start = Math.min(start, activeSegment.start);
    end = actualEnd;
    let ordinal = sourceStart;
    const boundaryMessage = sourceStart < ctx.boundary
      ? activePage.messages.findIndex((message) => message.historyId === ctx.boundaryLastId) : -1;
    const selectedTools = new Set<string>();
    activeMessages = activePage.messages.filter((message, index) => {
      if (!visible(message)) return false;
      const selected = boundaryMessage >= 0 ? index > boundaryMessage : ordinal >= ctx.boundary;
      ordinal++;
      if (selected) for (const call of message.toolCalls ?? []) selectedTools.add(call.id);
      return selected;
    });
    const selectedMessages = new Set(activeMessages);
    activeMessages = activePage.messages.filter((message) => selectedMessages.has(message)
      || (message.role === "tool" && !!message.toolCallId && selectedTools.has(message.toolCallId)));
    pageEvents = activePage.events;
  } else pageEvents = []; // Older immutable windows must not duplicate live question cards.
  const messages: Message[] = [];
  for (const segment of ctx.segments) {
    if (segment.end <= start || segment.start >= end) continue;
    const phaseMarkers = markers(segment);
    messages.push(...phaseMarkers.filter((_, index) => segment.start + index >= start && segment.start + index < end));
    if (segment.record) messages.push(...ctx.store.page(segment.record.id,
      Math.max(0, start - segment.contentStart), Math.min(segment.count, end - segment.contentStart)));
    else messages.push(...activeMessages);
  }
  return detail(ctx, messages, start, end, kind, pageEvents);
}

export async function loadEngineThreadQueryIndex(sessionId: string): Promise<SessionQueryIndex | null> {
  const ctx = await context(sessionId);
  if (!ctx) return null;
  const entries: SessionQueryIndex["entries"] = [];
  for (const segment of ctx.segments) if (segment.record) {
    for (const entry of ctx.store.queries(segment.record.id)) entries.push({
      messageId: entry.history_id, ordinal: entries.length + 1, preview: entry.preview,
      pageToken: encodeSessionHistoryAnchor(ctx.revision, segment.contentStart + entry.ordinal),
    });
  }
  const activeIndex = await ctx.service.getQueryIndex(ctx.active.id);
  if (activeIndex.revision !== ctx.active.history?.revision) throw new StaleSessionAnchorError();
  const activeSegment = ctx.segments.at(-1)!;
  for (const entry of activeIndex.entries) {
    const ordinal = decodeSessionHistoryAnchor(entry.pageToken, activeIndex.revision);
    if (ordinal < ctx.boundary) continue;
    let preview = entry.preview;
    if (preview.startsWith("[引擎切换上下文交接")) {
      const key = JSON.stringify([ctx.active.id, entry.messageId]);
      const cached = queryPreviews.get(key);
      if (cached !== undefined) preview = cached;
      else {
        // Native indexes precede envelope cleanup. Recover only this prompt's
        // core page, keeping both its native identity and ordinal unchanged.
        const page = await ctx.service.get(ctx.active.id, { anchor: entry.pageToken, limit: 1,
          ...(ctx.active.agentType === "codex" ? { view: "core" as const } : {}) });
        if (page.history?.revision !== activeIndex.revision) throw new StaleSessionAnchorError();
        const prompt = page.messages.find((message) => message.historyId === entry.messageId);
        if (prompt) preview = prompt.content.replace(/\s+/g, " ").trim().slice(0, 120) || "图片消息";
        if (queryPreviews.size >= 128) queryPreviews.delete(queryPreviews.keys().next().value!);
        queryPreviews.set(key, preview);
      }
    }
    entries.push({ ...entry, preview, ordinal: entries.length + 1,
      messageId: entry.messageId,
      pageToken: encodeSessionHistoryAnchor(ctx.revision, activeSegment.contentStart + ordinal - ctx.boundary) });
  }
  return { sessionId: ctx.active.id, revision: ctx.revision, totalQueries: entries.length, entries };
}

export async function loadEngineThreadHistoryItem(sessionId: string, itemId: string): Promise<Message | null> {
  const ctx = await context(sessionId);
  if (!ctx) return null;
  for (const record of ctx.records) {
    const item = ctx.store.item(record.id, itemId);
    if (item) return item;
  }
  // Explicit item recovery uses the same native ordinal space as display.
  let page = ctx.active;
  const visited = new Set<string>();
  for (;;) {
    const item = page.messages.find((message) => message.historyId === itemId);
    if (item) return item;
    const before = page.history?.nextCursor;
    if (!before || page.history?.hasMore === false || visited.has(before)) return null;
    visited.add(before);
    page = await ctx.service.get(ctx.active.id, { before, limit: 100,
      ...(ctx.active.agentType === "codex" ? { view: "core" as const } : {}) });
  }
}

export async function loadEngineThreadToolResult(sessionId: string, ref: Pick<SessionToolResultRef, "turnId" | "itemId" | "revision">) {
  if (!ref.turnId.startsWith("engine-frozen:")) return null;
  const { thread, records } = getEngineSwitchContainer().ledger.ledger(sessionId, false);
  if (!thread) throw new StaleSessionAnchorError();
  const record = records.find((record) => ref.turnId.startsWith(`engine-frozen:${encodeURIComponent(record.id)}:`));
  if (!record || ref.revision !== record.id) throw new StaleSessionAnchorError();
  const item = getEngineHistoryStore().item(record.id, ref.itemId, true);
  if (!item) throw new Error("History tool result not found");
  return { ...ref, content: item.content, byteSize: Buffer.byteLength(item.content, "utf8"), isError: item.isError };
}

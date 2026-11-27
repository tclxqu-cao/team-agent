import { type AgentEvent, type Message, type SessionHistoryQuery, type SessionHistoryView, type SessionHistoryWindow } from "@agent/core";
export declare function normalizeNativePageSize(limit?: number): number;
export declare function nativeHistoryCursor(ordinal: number): string;
export declare function decodeNativeHistoryCursor(cursor: string | undefined, fallback: number): number;
/** Indices of the messages that consume an ordinal (user/assistant only). */
export declare function nativeHistorySkeleton(messages: readonly Message[]): number[];
/**
 * Shared window selection over an adapter's skeleton — same turn-boundary and
 * cursor semantics as codex's selectNativeRange, so latest/before/after/anchor
 * behave identically across native runtimes.
 */
export declare function selectNativeHistoryRange(skeletonMessages: readonly Message[], query: SessionHistoryQuery, revision: string): {
    start: number;
    end: number;
    kind: "latest" | "anchored";
};
/**
 * Materializes one window: visible messages carry historyIds bound to the
 * skeleton ordinals, their tool results ride along, and page events are
 * filtered to the window's tool calls (same rules as the core paginator).
 */
export declare function buildNativeHistoryPage(messages: readonly Message[], skeleton: readonly number[], start: number, end: number, events: readonly AgentEvent[]): {
    messages: Message[];
    events: AgentEvent[];
};
export declare function nativeHistoryWindow(start: number, end: number, totalItems: number, kind: "latest" | "anchored", revision: string, delivery?: SessionHistoryView | "legacy-full"): SessionHistoryWindow;
//# sourceMappingURL=native-history-paging.d.ts.map
import type { StreamEvent } from "../entities.js";
/** Retry once only when the server explicitly rejects the usage option itself. */
export declare function fetchWithUsageFallback(url: string, init: RequestInit, body: Record<string, unknown>): Promise<Response>;
/** Collect one request's provider counters, then emit its final snapshot once. */
export declare class ProviderUsage {
    private inputTokens?;
    private outputTokens?;
    private cacheReadTokens?;
    private cacheWriteTokens?;
    private emitted;
    recordOpenAI(value: unknown): void;
    /** Returns whether this frame supplies a valid output counter. */
    recordAnthropic(value: unknown): boolean;
    take(complete: boolean, includeCacheInInput?: boolean): Extract<StreamEvent, {
        type: "usage";
    }> | undefined;
}
//# sourceMappingURL=usage.d.ts.map
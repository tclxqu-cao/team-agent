import type { TokenUsage } from './entities.js';
export declare class RunUsageAccumulator {
    private requests;
    private reportedRequests;
    private inputTokens;
    private outputTokens;
    private cacheReadTokens;
    private cacheWriteTokens;
    private hasCacheRead;
    private hasCacheWrite;
    private partial;
    private current?;
    beginRequest(): void;
    observe(usage: TokenUsage): void;
    finishRequest(): void;
    markPartial(): void;
    snapshot(): TokenUsage | undefined;
}
//# sourceMappingURL=run-usage.d.ts.map
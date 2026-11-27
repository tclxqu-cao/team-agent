import type { Message } from "../model/entities.js";
export interface HandoffRendererOptions {
    budgetTokens?: number;
    /** Retained for callers of the initial API; items are now omitted whole. */
    toolResultMaxChars?: number;
    messageMaxChars?: number;
    historyFile?: string;
    workStateText?: string;
    purpose?: "fork";
}
export interface RenderedHandoff {
    summaryText: string;
    omittedHistoryIds: string[];
    includedHistoryIds: string[];
    images: string[];
    tokenEstimate: number;
}
/** Keep whole facts in original order. Every omission remains recoverable. */
export declare function renderContextHandoff(messages: readonly Message[], sourceLabel: string, targetAgentType: string, options?: HandoffRendererOptions): RenderedHandoff;
//# sourceMappingURL=handoff-renderer.d.ts.map
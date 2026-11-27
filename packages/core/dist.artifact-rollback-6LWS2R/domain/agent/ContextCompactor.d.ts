import type { Message } from '../model/entities.js';
import type { IModelProvider } from '../model/entities.js';
export declare const COMPACTION_SUMMARY_PREFIX = "This is a summary of the conversation so far, written to preserve continuity after context compaction.";
export declare const COMPACTION_ACKNOWLEDGEMENT = "Understood. I have reviewed the summary and will continue from where we left off.";
export interface CompactResult {
    /** Compacted message list: [system, summary-user, summary-assistant, ...recentMessages] */
    messages: Message[];
    summary: string;
    removedMessages: number;
}
export interface ActiveCompactResult {
    /** Messages to persist for the session. Runtime/system environment is injected again on the next run. */
    replacementMessages: Message[];
    summary: string;
    recentMessages: Message[];
    removedMessages: number;
}
export declare class ContextCompactor {
    private readonly modelProvider;
    constructor(modelProvider: IModelProvider);
    /**
     * Step 1 (lightweight): Strip verbose tool results from old messages.
     * Keeps the last `keepRecent` tool-result messages intact.
     */
    pruneToolResults(messages: Message[], keepRecent?: number): Message[];
    /**
     * Step 2 (AutoCompact): Fork a summarization LLM call, replace the
     * conversation body with a single summary message pair, keep the
     * system prompt and the most recent `keepRecent` messages.
     */
    compact(messages: Message[], keepRecent?: number, contextWindow?: number): Promise<CompactResult>;
    compactForHandoff(messages: Message[]): Promise<ActiveCompactResult>;
    /**
     * Estimate token count using the provider's countTokens if available,
     * otherwise fall back to char/4 heuristic.
     */
    estimateTokens(messages: Message[]): Promise<number>;
    private collectRecentUserMessages;
    private isSummaryMessage;
}
//# sourceMappingURL=ContextCompactor.d.ts.map
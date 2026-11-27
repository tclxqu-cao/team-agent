import type { IAgentLoop, AgentEvent, AgentConfig, SessionCompaction } from './entities.js';
export declare class AgentLoop implements IAgentLoop {
    private readonly config;
    private readonly compactor;
    private abortController;
    /** Names of tools registered at construction time. Tools added AFTER construction
     *  (session tools, MCP tools) are always visible to the LLM regardless of enabledTools. */
    private readonly initialToolNames;
    constructor(config: AgentConfig);
    /**
     * Remove orphaned assistant tool_calls messages and their partial tool responses
     * from session history. This prevents "insufficient tool messages following
     * tool_calls message" errors from the model API.
     */
    private sanitizeHistory;
    run(input: string, sessionId: string, images?: string[]): AsyncIterable<AgentEvent>;
    abort(): void;
    /**
     * On-demand compaction of the persisted session history. Mirrors the
     * automatic threshold compaction: prune tool results, summarize the head,
     * keep the recent tail, and persist a hidden checkpoint so the next run()
     * restores the compacted context. Returns null when nothing was compacted.
     */
    compactSession(sessionId: string): Promise<SessionCompaction | null>;
    /** Persist a self-contained checkpoint so the NEXT run restores the compacted context. */
    private persistCompactionCheckpoint;
    /**
     * Return tool definitions filtered by enabledTools.
     * Tools registered after construction (session tools, MCP tools) are always included.
     */
    private getFilteredToolDefinitions;
}
//# sourceMappingURL=AgentLoop.d.ts.map
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
export interface CodexRolloutUserMessage {
    turnId: string;
    itemId?: string;
    content: Array<Record<string, unknown>>;
}
export declare function codexRolloutActivityFromLine(line: Buffer | string): CodexRolloutActivity;
/**
 * Reads only the rollout tail and returns a final answer that is newer than
 * the latest start/terminal boundary. This covers the short interval where
 * the final response_item is durable but task_complete has not arrived yet.
 */
export declare function readCodexRolloutFinalizingAnswer(path: string, maxBytes?: number): Promise<CodexRolloutFinalAnswer | null>;
export declare class CodexRolloutCommentaryReader {
    private readonly chunkSize;
    private readonly cache;
    constructor(chunkSize?: number);
    read(path: string, turnId: string): Promise<CodexRolloutCommentarySnapshot>;
    private readAppendedCommentary;
    private consumeCommentaryLine;
}
/**
 * Incrementally reads only durable user-message items from a rollout. Codex
 * turn summaries expose the first user message per turn, so steered inputs
 * need this lightweight source to remain visible in core history.
 */
export declare class CodexRolloutUserMessageReader {
    private readonly chunkSize;
    private readonly cache;
    constructor(chunkSize?: number);
    read(path: string): Promise<Map<string, CodexRolloutUserMessage[]>>;
    private readAppended;
    private consumeLine;
}
export declare class CodexRolloutActivityReader {
    private readonly chunkSize;
    private readonly cache;
    constructor(chunkSize?: number);
    read(path: string): Promise<CodexRolloutActivity>;
    readMany(paths: Iterable<string>): Promise<Map<string, CodexRolloutActivity>>;
    private bootstrap;
    private readAppended;
}
//# sourceMappingURL=codex-rollout-activity.d.ts.map
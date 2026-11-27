import { type Message } from "@agent/core";
type Item = Record<string, unknown> & {
    type: string;
    id?: string;
};
type Turn = {
    id: string;
    status: string;
    items: Item[];
};
export declare function codexAsyncQuestionId(threadId: string, itemId: string, index: number): string;
export declare function parseCodexAsyncQuestionId(id: string): {
    threadId: string;
    itemId: string;
    index: number;
} | null;
/** Native async questions remain answerable after the requesting turn completes. */
export declare function codexQuestionHistory(turns: readonly Turn[], threadId?: string): Map<string, Message[]>;
export declare function codexQuestionReply(id: string, question: string, answer: string): string;
export {};
//# sourceMappingURL=codex-questions.d.ts.map
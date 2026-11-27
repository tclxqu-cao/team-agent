import type { Message } from "@agent/core";
/** Durable, readable recovery path for context omitted from the native prompt. */
export declare function materializeContextHistory(runtimeDirectory: string, input: {
    id: string;
    messages: Message[];
    workStateText: string;
}): Promise<string>;
//# sourceMappingURL=context-history-artifact.d.ts.map
import type { Message } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
export interface ZCodeQuestionHistoryOptions {
    includePendingQuestions?: boolean;
    pendingInteractionIds?: ReadonlyMap<string, string>;
    pendingQuestionInputs?: ReadonlyMap<string, NativeJsonPacket>;
    handledQuestionToolIds?: ReadonlySet<string>;
}
/** Reannounced callbacks retain their native identity, including after a reply. */
export declare function zcodeInteractionId(method: string, params: NativeJsonPacket): string;
export declare function isZCodeQuestionTool(name: unknown): boolean;
export declare function zcodePendingQuestionId(interactionId: string, index: number): string;
export declare function parseZCodePendingQuestionId(id: string): string | undefined;
/** Only a still-open question in the fetched history can use a recovery snapshot. */
export declare function zcodePendingQuestionToolIds(history: readonly NativeJsonPacket[], handled?: ReadonlySet<string>): string[];
/** Read pending AskUserQuestion identities and their input from a session snapshot. */
export declare function zcodePendingQuestionsFromSnapshot(value: unknown): {
    interactionIds: Map<string, string>;
    inputs: Map<string, NativeJsonPacket>;
};
/** Recover a pending card only when the native snapshot supplies its answer target. */
export declare function zcodeQuestionHistory(part: NativeJsonPacket, sessionId: string, messageId: string, options?: ZCodeQuestionHistoryOptions): Message[] | null;
//# sourceMappingURL=zcode-questions.d.ts.map
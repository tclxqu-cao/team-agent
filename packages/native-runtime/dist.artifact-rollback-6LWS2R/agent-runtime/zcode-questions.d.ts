import type { Message } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
export interface ZCodeQuestionHistoryOptions {
    includePendingQuestions?: boolean;
    pendingInteractionIds?: ReadonlyMap<string, string>;
}
/** Reannounced callbacks retain their native identity, including after a reply. */
export declare function zcodeInteractionId(method: string, params: NativeJsonPacket): string;
export declare function isZCodeQuestionTool(name: unknown): boolean;
export declare function zcodeExternalQuestionId(interactionId: string, index: number): string;
/** Recover the native interaction identity needed to answer an external question. */
export declare function zcodePendingInteractionIds(value: unknown): Map<string, string>;
/** Pending questions are live events; settled questions are read-only native history. */
export declare function zcodeQuestionHistory(part: NativeJsonPacket, sessionId: string, messageId: string, options?: ZCodeQuestionHistoryOptions): Message[] | null;
//# sourceMappingURL=zcode-questions.d.ts.map
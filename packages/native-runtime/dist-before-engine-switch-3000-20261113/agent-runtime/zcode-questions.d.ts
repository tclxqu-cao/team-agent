import type { Message } from "@agent/core";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
/** Reannounced callbacks retain their native identity, including after a reply. */
export declare function zcodeInteractionId(method: string, params: NativeJsonPacket): string;
export declare function isZCodeQuestionTool(name: unknown): boolean;
/** Pending questions are live events; settled questions are read-only native history. */
export declare function zcodeQuestionHistory(part: NativeJsonPacket, sessionId: string, messageId: string): Message[] | null;
//# sourceMappingURL=zcode-questions.d.ts.map
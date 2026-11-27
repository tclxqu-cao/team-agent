import type { Message } from "../model/entities.js";
import type { SessionQueryIndex } from "./entities.js";
export declare class StaleSessionAnchorError extends Error {
    readonly code = "STALE_SESSION_ANCHOR";
    constructor();
}
export declare function buildSessionQueryIndex(sessionId: string, messages: readonly Message[], revision?: string): SessionQueryIndex;
export declare function computeSessionHistoryRevision(messages: readonly Message[]): string;
export declare function sessionHistoryMessageId(visibleIndex: number, message: Message): string;
export declare function encodeSessionHistoryAnchor(revision: string, visibleIndex: number): string;
export declare function decodeSessionHistoryAnchor(token: string, revision: string): number;
export declare function visibleSessionMessages(messages: readonly Message[]): Array<{
    message: Message;
    visibleIndex: number;
}>;
//# sourceMappingURL=SessionQueryIndex.d.ts.map
import type { Message, SessionForkPoint } from "@agent/core";
export declare function parseSessionForkPoint(value: unknown): SessionForkPoint;
/** Require the last assistant response before the next user input. */
export declare function completedForkMessageIndex(messages: readonly Message[], messageId: string, isRunning: boolean): number;
//# sourceMappingURL=session-fork-point.d.ts.map
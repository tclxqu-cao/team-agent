export type SessionGoalStatus = "queued" | "active" | "completed" | "failed" | "cancelled";
export type SessionQueueItemKind = "goal" | "message";
export interface SessionMessagePayload {
    images?: string[];
    agentIds?: string[];
    agentName?: string;
}
export interface SessionGoal {
    id: string;
    sessionId: string;
    objective: string;
    status: SessionGoalStatus;
    position: number;
    createdAt: number;
    updatedAt: number;
    sourceMessageId?: string;
    /** Missing on legacy records, where the item is always a goal. */
    kind?: SessionQueueItemKind;
    messagePayload?: SessionMessagePayload;
    iterations?: number;
    lastReason?: string;
}
export interface SessionGoalState {
    active: SessionGoal | null;
    queued: SessionGoal[];
    history: SessionGoal[];
}
export declare const EMPTY_SESSION_GOAL_STATE: SessionGoalState;
export declare const SESSION_GOAL_METADATA_KEY = "goalState";
export declare function readSessionGoalState(metadata: Record<string, unknown> | undefined): SessionGoalState;
export declare function writeSessionGoalState(metadata: Record<string, unknown> | undefined, state: SessionGoalState): Record<string, unknown>;
export declare function enqueueSessionGoal(state: SessionGoalState, input: {
    id: string;
    sessionId: string;
    objective: string;
    sourceMessageId?: string;
    now: number;
}): SessionGoalState;
export declare function enqueueSessionMessage(state: SessionGoalState, input: {
    id: string;
    sessionId: string;
    objective: string;
    sourceMessageId: string;
    messagePayload?: SessionMessagePayload;
    now: number;
    activate: boolean;
}): SessionGoalState;
export declare function reorderQueuedSessionGoals(state: SessionGoalState, orderedIds: readonly string[]): SessionGoalState;
export declare function reorderQueuedSessionMessages(state: SessionGoalState, orderedIds: readonly string[]): SessionGoalState;
export declare function updateQueuedSessionMessage(state: SessionGoalState, messageId: string, objective: string, messagePayload?: SessionMessagePayload, now?: number): SessionGoalState;
export declare function queuedSessionMessages(state: SessionGoalState): SessionGoal[];
export declare function projectSessionGoals(state: SessionGoalState): SessionGoalState;
export declare function sessionQueueItemKind(item: SessionGoal): SessionQueueItemKind;
export declare function promoteNextSessionQueueItem(state: SessionGoalState, now: number): SessionGoalState;
export declare function finishActiveSessionGoal(state: SessionGoalState, outcome: "completed" | "failed" | "cancelled", now: number, lastReason?: string): SessionGoalState;
export declare function cancelSessionGoal(state: SessionGoalState, goalId: string, now: number): SessionGoalState;
export declare function cancelQueuedSessionMessage(state: SessionGoalState, messageId: string): SessionGoalState;
export declare function normalizeGoalObjective(value: string): string;
//# sourceMappingURL=SessionGoals.d.ts.map
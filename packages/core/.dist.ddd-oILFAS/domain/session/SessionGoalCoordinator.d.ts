import type { ISessionStore } from "./entities.js";
import { type SessionGoalState } from "./SessionGoals.js";
export interface CustomerGoalRunResult {
    outcome: "completed" | "failed";
    reason?: string;
}
export declare class SessionGoalCoordinator {
    private readonly store;
    private readonly runGoal;
    private readonly abortGoal;
    private readonly createId;
    private readonly now;
    private readonly running;
    private readonly mutationTails;
    constructor(store: ISessionStore, runGoal: (sessionId: string, objective: string) => Promise<CustomerGoalRunResult>, abortGoal: (sessionId: string) => Promise<void> | void, createId?: () => string, now?: () => number);
    get(sessionId: string, resume?: boolean): Promise<SessionGoalState>;
    enqueue(sessionId: string, objective: string, sourceMessageId?: string): Promise<SessionGoalState>;
    reorder(sessionId: string, orderedIds: readonly string[]): Promise<SessionGoalState>;
    cancel(sessionId: string, goalId: string): Promise<SessionGoalState>;
    isRunning(sessionId: string): boolean;
    private ensureRunning;
    private drain;
    private withSessionMutation;
    private requireSession;
}
//# sourceMappingURL=SessionGoalCoordinator.d.ts.map
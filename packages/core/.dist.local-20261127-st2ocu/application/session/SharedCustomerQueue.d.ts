import { type SessionGoal, type SessionGoalState, type SessionMessagePayload } from "../../domain/session/SessionGoals.js";
import type { ISessionStore } from "../../domain/session/entities.js";
/** One server-owned queue per session; both clients mutate the same metadata. */
export declare class SharedCustomerQueue {
    private readonly store;
    private readonly busy;
    private readonly run;
    private readonly abort;
    private readonly steerRun;
    private readonly persist?;
    private readonly tails;
    private readonly draining;
    constructor(store: ISessionStore, busy: (id: string) => boolean, run: (id: string, item: SessionGoal) => Promise<"completed" | "failed">, abort: (id: string) => void, steerRun: (id: string, text: string) => Promise<boolean>, persist?: ((id: string, state: SessionGoalState) => void) | undefined);
    get(id: string, resume?: boolean): Promise<SessionGoalState>;
    enqueue(id: string, objective: string, sourceMessageId?: string): Promise<SessionGoalState>;
    enqueueMessage(id: string, objective: string, sourceMessageId: string, messagePayload?: SessionMessagePayload): Promise<SessionGoalState>;
    reorder(id: string, ids: string[], messages?: boolean): Promise<SessionGoalState>;
    updateGoal(id: string, goalId: string, objective: string): Promise<SessionGoalState>;
    updateMessage(id: string, itemId: string, text: string, payload?: SessionMessagePayload): Promise<SessionGoalState>;
    cancel(id: string, itemId: string): Promise<SessionGoalState>;
    steer(id: string, itemId: string, kind?: "goal" | "message"): Promise<SessionGoalState>;
    resume(id: string): void;
    private drain;
    private require;
    private mutate;
}
//# sourceMappingURL=SharedCustomerQueue.d.ts.map
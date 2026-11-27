export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
/** 模型可通过 update_goal 工具设置的状态；resume 与预算类状态归用户和系统管。 */
export declare const MODEL_ALLOWED_GOAL_STATUSES: readonly ThreadGoalStatus[];
export declare const THREAD_GOAL_STATUSES: readonly ThreadGoalStatus[];
export interface ThreadGoal {
    sessionId: string;
    objective: string;
    status: ThreadGoalStatus;
    /** null = 不限预算，目标靠 complete/blocked/暂停 收束。 */
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
    /** 已完成的续跑轮数（含触发本轮目标的首轮之后的所有轮）。 */
    turnCount: number;
    createdAt: string;
    updatedAt: string;
}
export interface ThreadGoalUsage {
    /** 本轮新增 token 估算值。 */
    tokens: number;
    /** 本轮实际耗时秒数。 */
    seconds: number;
}
export interface IThreadGoalStore {
    get(sessionId: string): Promise<ThreadGoal | null>;
    set(goal: ThreadGoal): Promise<void>;
    clear(sessionId: string): Promise<boolean>;
    listActive(): Promise<ThreadGoal[]>;
}
/** 隐藏 steering 消息的 name 标记：进模型上下文，但客户端展示层过滤。 */
export declare const GOAL_MESSAGE_NAME = "__goal__";
/** 客户端展示层过滤：目标 steering 消息只给模型看，不出现在会话消息列表。 */
export declare function isInternalGoalMessage(message: {
    name?: string;
}): boolean;
export declare const GOAL_CONTEXT_SOURCE = "goal";
export declare const THREAD_GOAL_OBJECTIVE_MAX_LENGTH = 4000;
export declare function isThreadGoalStatus(value: unknown): value is ThreadGoalStatus;
export declare function createThreadGoal(sessionId: string, objective: string, options?: {
    tokenBudget?: number | null;
    now?: string;
}): ThreadGoal;
/** 累计一轮的用量增量；预算耗尽时把 active 翻成 budget_limited。 */
export declare function recordThreadGoalUsage(goal: ThreadGoal, usage: ThreadGoalUsage): ThreadGoal;
/** 是否还应以目标名义继续续跑（仅状态 + 预算判断，不含并发检查）。 */
export declare function shouldContinueThreadGoal(goal: ThreadGoal): boolean;
export declare function remainingTokenBudget(goal: ThreadGoal): number | null;
/** 目标文本变更时生成的一条隐藏 steering 消息正文。 */
export declare function buildObjectiveUpdatedMessage(goal: ThreadGoal): string;
/** 预算耗尽时注入（ informational）；系统同时停止续跑。 */
export declare function buildBudgetExhaustedMessage(goal: ThreadGoal): string;
/** 每轮续跑开头注入的隐藏 steering 消息正文：全量携带目标 + 预算 + 行为规则。 */
export declare function buildGoalContinuationMessage(goal: ThreadGoal): string;
//# sourceMappingURL=ThreadGoal.d.ts.map
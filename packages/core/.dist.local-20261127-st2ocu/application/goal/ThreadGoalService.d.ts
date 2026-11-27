import type { IThreadGoalStore, ThreadGoal, ThreadGoalStatus, ThreadGoalUsage } from '../../domain/goal/ThreadGoal.js';
export interface ThreadGoalDriver {
    isSessionRunning(sessionId: string): boolean;
    /** 以目标名义启动一轮新 turn（隐藏 steering 消息作为输入）。返回是否真正启动。 */
    startTurn(sessionId: string, input: string): Promise<boolean>;
    /** 向运行中的 turn 注入一条隐藏消息（下一迭代被拾取）。返回是否有运行中的 turn。 */
    steerHidden(sessionId: string, content: string): Promise<boolean>;
    sessionExists?(sessionId: string): Promise<boolean>;
}
export interface ThreadGoalNotifier {
    onUpdated(sessionId: string, goal: ThreadGoal): void;
    onCleared(sessionId: string): void;
}
export interface RunSettledInfo extends ThreadGoalUsage {
    sessionId: string;
    /** run 以 error/异常收尾时为 true；此时不做自动续跑，避免错误循环。 */
    failed: boolean;
    /** 失败原因看起来是用量/限流类错误时，目标翻成 usage_limited 等待人工恢复。 */
    usageLimited?: boolean;
}
export declare class ThreadGoalService {
    private readonly store;
    private readonly driver;
    private readonly notifier;
    /** 用户中断（abort）后待消费的一次性续跑抑制；对齐 TUI abortingRef 语义。 */
    private readonly userStopped;
    constructor(store: IThreadGoalStore, driver: ThreadGoalDriver, notifier: ThreadGoalNotifier);
    /**
     * 用户主动中断当前 turn：抑制紧随其后的自动续跑（仅一轮）。
     * turn_aborted 不是 failed，若不拦住，settleTurn 会立刻用目标消息重新起轮，
     * 用户在 WebApp 上按“停止生成”就永远停不下来。重新设置/恢复目标时清除。
     */
    requestStop(sessionId: string): void;
    getGoal(sessionId: string): Promise<ThreadGoal | null>;
    /** 设置（或替换）目标。空闲时立刻起一轮；运行中且目标变化时注入 objective 更新消息。 */
    setGoal(sessionId: string, objective: string, options?: {
        tokenBudget?: number | null;
    }): Promise<ThreadGoal>;
    clearGoal(sessionId: string): Promise<boolean>;
    pauseGoal(sessionId: string): Promise<ThreadGoal>;
    /** 恢复目标：从 paused/blocked/usage_limited/budget_limited 回到 active；空闲则立刻续跑。 */
    resumeGoal(sessionId: string): Promise<ThreadGoal>;
    /** 模型通过 update_goal 工具改状态：只允许 complete/blocked/paused，且只能从 active 出发。 */
    applyModelStatusUpdate(sessionId: string, status: ThreadGoalStatus): Promise<ThreadGoal>;
    /** 一轮 run 结束后的核算与续跑决策；server 自动起轮，TUI 只取决策自己排队。 */
    settleTurn(info: RunSettledInfo): Promise<{
        goal: ThreadGoal | null;
        shouldContinue: boolean;
        continuationMessage: string | null;
        budgetExhausted: boolean;
    }>;
    /**
     * 一轮 run 结束后的空闲钩子：核算用量（含以 complete/blocked 收束的终轮）；
     * 目标仍 active 且预算未耗尽时，以隐藏 steering 消息自动开下一轮。
     * 失败的 run 不续跑（防错误循环），用量类失败翻成 usage_limited 等待人工 resume。
     */
    onRunSettled(info: RunSettledInfo): Promise<void>;
    /** 预算恰好在本轮耗尽时，向运行中的 turn 告知（informational，由 driver 决定能否送达）。 */
    notifyBudgetExhausted(sessionId: string): Promise<void>;
    /** 进程重启后恢复：所有 active 目标若会话空闲则续跑。 */
    resumeInterrupted(): Promise<number>;
    private transition;
}
//# sourceMappingURL=ThreadGoalService.d.ts.map
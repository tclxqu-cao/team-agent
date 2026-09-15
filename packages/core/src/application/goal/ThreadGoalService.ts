// ── Thread Goal Application Service ──
// 目标模式的用例编排：set/get/clear/pause/resume、空闲续跑决策、用量核算。
// 领域规则在 domain/goal，持久化通过 IThreadGoalStore，起轮/注入通过
// ThreadGoalDriver（server 侧接到 AgentHost），通知通过 ThreadGoalNotifier。
import type { IThreadGoalStore, ThreadGoal, ThreadGoalStatus, ThreadGoalUsage } from '../../domain/goal/ThreadGoal.js';
import {
  MODEL_ALLOWED_GOAL_STATUSES,
  buildBudgetExhaustedMessage,
  buildGoalContinuationMessage,
  buildObjectiveUpdatedMessage,
  createThreadGoal,
  recordThreadGoalUsage,
  shouldContinueThreadGoal,
} from '../../domain/goal/ThreadGoal.js';

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

export class ThreadGoalService {
  constructor(
    private readonly store: IThreadGoalStore,
    private readonly driver: ThreadGoalDriver,
    private readonly notifier: ThreadGoalNotifier,
  ) {}

  async getGoal(sessionId: string): Promise<ThreadGoal | null> {
    return this.store.get(sessionId);
  }

  /** 设置（或替换）目标。空闲时立刻起一轮；运行中且目标变化时注入 objective 更新消息。 */
  async setGoal(
    sessionId: string,
    objective: string,
    options: { tokenBudget?: number | null } = {},
  ): Promise<ThreadGoal> {
    const existing = await this.store.get(sessionId);
    // 借 createThreadGoal 做目标文本与预算的领域校验（trim、长度、预算为正）。
    const validated = createThreadGoal(sessionId, objective, {
      tokenBudget: options.tokenBudget ?? existing?.tokenBudget ?? null,
    });
    const goal: ThreadGoal = existing
      ? {
          ...existing,
          objective: validated.objective,
          status: "active",
          tokenBudget: validated.tokenBudget,
          updatedAt: new Date().toISOString(),
        }
      : validated;
    await this.store.set(goal);
    this.notifier.onUpdated(sessionId, goal);

    const objectiveChanged = !existing || existing.objective !== goal.objective;
    const wasActive = existing?.status === "active";
    if (this.driver.isSessionRunning(sessionId)) {
      if (objectiveChanged && wasActive) {
        await this.driver.steerHidden(sessionId, buildObjectiveUpdatedMessage(goal));
      }
      return goal;
    }
    if (shouldContinueThreadGoal(goal)) {
      await this.driver.startTurn(sessionId, buildGoalContinuationMessage(goal));
    }
    return goal;
  }

  async clearGoal(sessionId: string): Promise<boolean> {
    const cleared = await this.store.clear(sessionId);
    if (cleared) this.notifier.onCleared(sessionId);
    return cleared;
  }

  async pauseGoal(sessionId: string): Promise<ThreadGoal> {
    return this.transition(sessionId, "paused", { allowedFrom: ["active"] });
  }

  /** 恢复目标：从 paused/blocked/usage_limited/budget_limited 回到 active；空闲则立刻续跑。 */
  async resumeGoal(sessionId: string): Promise<ThreadGoal> {
    const goal = await this.transition(sessionId, "active", {
      allowedFrom: ["paused", "blocked", "usage_limited", "budget_limited"],
    });
    if (!this.driver.isSessionRunning(sessionId) && shouldContinueThreadGoal(goal)) {
      await this.driver.startTurn(sessionId, buildGoalContinuationMessage(goal));
    }
    return goal;
  }

  /** 模型通过 update_goal 工具改状态：只允许 complete/blocked/paused，且只能从 active 出发。 */
  async applyModelStatusUpdate(sessionId: string, status: ThreadGoalStatus): Promise<ThreadGoal> {
    if (!(MODEL_ALLOWED_GOAL_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`update_goal 只允许设置 ${MODEL_ALLOWED_GOAL_STATUSES.join("/")}，${status} 归用户和系统管理`);
    }
    return this.transition(sessionId, status, { allowedFrom: ["active"] });
  }

  /** 一轮 run 结束后的核算与续跑决策；server 自动起轮，TUI 只取决策自己排队。 */
  async settleTurn(info: RunSettledInfo): Promise<{
    goal: ThreadGoal | null;
    shouldContinue: boolean;
    continuationMessage: string | null;
    budgetExhausted: boolean;
  }> {
    const current = await this.store.get(info.sessionId);
    if (!current) return { goal: null, shouldContinue: false, continuationMessage: null, budgetExhausted: false };
    if (current.status !== "active") {
      // 终轮（模型已标 complete/blocked 等）不再续跑，但本轮用量仍要记账。
      if (info.tokens > 0 || info.seconds > 0) {
        const final = recordThreadGoalUsage(current, { tokens: info.tokens, seconds: info.seconds });
        await this.store.set(final);
        this.notifier.onUpdated(info.sessionId, final);
        return { goal: final, shouldContinue: false, continuationMessage: null, budgetExhausted: false };
      }
      return { goal: current, shouldContinue: false, continuationMessage: null, budgetExhausted: false };
    }
    const updated = recordThreadGoalUsage(current, { tokens: info.tokens, seconds: info.seconds });
    let goal = updated;

    if (info.failed) {
      if (info.usageLimited) goal = { ...updated, status: "usage_limited", updatedAt: new Date().toISOString() };
      await this.store.set(goal);
      this.notifier.onUpdated(info.sessionId, goal);
      return { goal, shouldContinue: false, continuationMessage: null, budgetExhausted: false };
    }
    if (!shouldContinueThreadGoal(updated)) {
      const budgetExhausted = updated.status === "budget_limited";
      await this.store.set(goal);
      this.notifier.onUpdated(info.sessionId, goal);
      return { goal, shouldContinue: false, continuationMessage: null, budgetExhausted };
    }
    await this.store.set(goal);
    this.notifier.onUpdated(info.sessionId, goal);
    return {
      goal,
      shouldContinue: true,
      continuationMessage: buildGoalContinuationMessage(goal),
      budgetExhausted: false,
    };
  }

  /**
   * 一轮 run 结束后的空闲钩子：核算用量（含以 complete/blocked 收束的终轮）；
   * 目标仍 active 且预算未耗尽时，以隐藏 steering 消息自动开下一轮。
   * 失败的 run 不续跑（防错误循环），用量类失败翻成 usage_limited 等待人工 resume。
   */
  async onRunSettled(info: RunSettledInfo): Promise<void> {
    const settlement = await this.settleTurn(info);
    if (settlement.budgetExhausted) await this.notifyBudgetExhausted(info.sessionId);
    if (settlement.continuationMessage) {
      await this.driver.startTurn(info.sessionId, settlement.continuationMessage);
    }
  }

  /** 预算恰好在本轮耗尽时，向运行中的 turn 告知（informational，由 driver 决定能否送达）。 */
  async notifyBudgetExhausted(sessionId: string): Promise<void> {
    const goal = await this.store.get(sessionId);
    if (goal?.status === "budget_limited" && this.driver.isSessionRunning(sessionId)) {
      await this.driver.steerHidden(sessionId, buildBudgetExhaustedMessage(goal));
    }
  }

  /** 进程重启后恢复：所有 active 目标若会话空闲则续跑。 */
  async resumeInterrupted(): Promise<number> {
    const goals = await this.store.listActive();
    let resumed = 0;
    for (const goal of goals) {
      if (this.driver.sessionExists && !(await this.driver.sessionExists(goal.sessionId))) continue;
      if (this.driver.isSessionRunning(goal.sessionId)) continue;
      if (await this.driver.startTurn(goal.sessionId, buildGoalContinuationMessage(goal))) resumed++;
    }
    return resumed;
  }

  private async transition(
    sessionId: string,
    status: ThreadGoalStatus,
    options: { allowedFrom: readonly ThreadGoalStatus[]; reason?: string },
  ): Promise<ThreadGoal> {
    const goal = await this.store.get(sessionId);
    if (!goal) throw new Error("Session has no thread goal");
    if (!options.allowedFrom.includes(goal.status)) {
      throw new Error(`Cannot transition goal from ${goal.status} to ${status}`);
    }
    const next: ThreadGoal = { ...goal, status, updatedAt: new Date().toISOString() };
    await this.store.set(next);
    this.notifier.onUpdated(sessionId, next);
    return next;
  }
}

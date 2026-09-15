import { describe, expect, it } from "vitest";
import {
  MODEL_ALLOWED_GOAL_STATUSES,
  buildBudgetExhaustedMessage,
  buildGoalContinuationMessage,
  buildObjectiveUpdatedMessage,
  createThreadGoal,
  isThreadGoalStatus,
  recordThreadGoalUsage,
  remainingTokenBudget,
  shouldContinueThreadGoal,
} from "./ThreadGoal.js";

describe("ThreadGoal domain", () => {
  it("creates an active goal with trimmed objective and validates input", () => {
    const goal = createThreadGoal("s1", "  把 README 翻译成英文  ", { tokenBudget: 1000, now: "2026-09-15T00:00:00.000Z" });
    expect(goal.status).toBe("active");
    expect(goal.objective).toBe("把 README 翻译成英文");
    expect(goal.tokenBudget).toBe(1000);
    expect(goal.tokensUsed).toBe(0);
    expect(goal.turnCount).toBe(0);

    expect(() => createThreadGoal("s1", "   ")).toThrow(/required/);
    expect(() => createThreadGoal("s1", "x".repeat(4001))).toThrow(/4000/);
    expect(() => createThreadGoal("s1", "ok", { tokenBudget: 0 })).toThrow(/positive/);
    expect(() => createThreadGoal("s1", "ok", { tokenBudget: -5 })).toThrow(/positive/);
  });

  it("records usage increments and flips active to budget_limited when budget is exhausted", () => {
    const goal = createThreadGoal("s1", "obj", { tokenBudget: 100 });
    const after1 = recordThreadGoalUsage(goal, { tokens: 60, seconds: 12.4 });
    expect(after1.tokensUsed).toBe(60);
    expect(after1.status).toBe("active");
    expect(after1.turnCount).toBe(1);

    const after2 = recordThreadGoalUsage(after1, { tokens: 40, seconds: 3 });
    expect(after2.status).toBe("budget_limited");
    expect(after2.timeUsedSeconds).toBeCloseTo(15.4);
    expect(shouldContinueThreadGoal(after2)).toBe(false);
  });

  it("never flips non-active statuses to budget_limited and keeps unbounded goals running", () => {
    const paused = createThreadGoal("s1", "obj");
    const pausedUsed = recordThreadGoalUsage({ ...paused, status: "paused", tokenBudget: 10 }, { tokens: 99, seconds: 1 });
    expect(pausedUsed.status).toBe("paused");

    const unbounded = recordThreadGoalUsage(paused, { tokens: 10_000_000, seconds: 1 });
    expect(unbounded.status).toBe("active");
    expect(shouldContinueThreadGoal(unbounded)).toBe(true);
    expect(remainingTokenBudget(unbounded)).toBeNull();
  });

  it("gates continuation on status and budget", () => {
    const base = createThreadGoal("s1", "obj", { tokenBudget: 100 });
    expect(shouldContinueThreadGoal(base)).toBe(true);
    for (const status of ["paused", "blocked", "usage_limited", "budget_limited", "complete"] as const) {
      expect(shouldContinueThreadGoal({ ...base, status })).toBe(false);
    }
    expect(shouldContinueThreadGoal({ ...base, tokensUsed: 100 })).toBe(false);
  });

  it("exposes the model-allowed status set (no resume, no budget statuses)", () => {
    expect(MODEL_ALLOWED_GOAL_STATUSES).toEqual(["complete", "blocked", "paused"]);
    expect(isThreadGoalStatus("usage_limited")).toBe(true);
    expect(isThreadGoalStatus("running")).toBe(false);
  });

  it("builds a continuation steering message carrying objective, budget and rules", () => {
    const goal = recordThreadGoalUsage(createThreadGoal("s1", "整理输出目录并生成周报", { tokenBudget: 5000 }), { tokens: 1200, seconds: 90 });
    const message = buildGoalContinuationMessage(goal);
    expect(message).toContain('<goal_internal_context source="goal">');
    expect(message).toContain("整理输出目录并生成周报");
    expect(message).toContain("1200 / 5000（剩余 3800）");
    expect(message).toContain("第 2 轮");
    expect(message).toContain("连续 3 轮");
    expect(message).toContain('update_goal(status="complete")');
    expect(message).toContain("用户数据");
    expect(message.endsWith("</goal_internal_context>")).toBe(true);
  });

  it("builds objective-updated and budget-exhausted messages", () => {
    const goal = createThreadGoal("s1", "新目标内容", { tokenBudget: 100 });
    expect(buildObjectiveUpdatedMessage(goal)).toContain("新目标内容");
    const exhausted = recordThreadGoalUsage(goal, { tokens: 100, seconds: 1 });
    const message = buildBudgetExhaustedMessage(exhausted);
    expect(message).toContain("预算已用尽");
    expect(message).toContain("100 / 100");
  });
});

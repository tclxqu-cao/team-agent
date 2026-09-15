import { describe, expect, it } from "vitest";
import { ThreadGoalService, type RunSettledInfo, type ThreadGoalDriver, type ThreadGoalNotifier } from "./ThreadGoalService.js";
import { createThreadGoal, type IThreadGoalStore, type ThreadGoal } from "../../domain/goal/ThreadGoal.js";

class FakeStore implements IThreadGoalStore {
  readonly rows = new Map<string, ThreadGoal>();
  async get(sessionId: string) { return this.rows.get(sessionId) ?? null; }
  async set(goal: ThreadGoal) { this.rows.set(goal.sessionId, goal); }
  async clear(sessionId: string) { return this.rows.delete(sessionId); }
  async listActive() { return [...this.rows.values()].filter((goal) => goal.status === "active"); }
}

class FakeDriver implements ThreadGoalDriver {
  running = false;
  exists = true;
  readonly startedTurns: Array<{ sessionId: string; input: string }> = [];
  readonly steered: Array<{ sessionId: string; content: string }> = [];
  isSessionRunning() { return this.running; }
  async startTurn(sessionId: string, input: string) {
    this.startedTurns.push({ sessionId, input });
    return true;
  }
  async steerHidden(sessionId: string, content: string) {
    this.steered.push({ sessionId, content });
    return this.running;
  }
  async sessionExists() { return this.exists; }
}

class FakeNotifier implements ThreadGoalNotifier {
  readonly updated: ThreadGoal[] = [];
  cleared = 0;
  onUpdated(_sessionId: string, goal: ThreadGoal) { this.updated.push(goal); }
  onCleared() { this.cleared++; }
}

function makeService() {
  const store = new FakeStore();
  const driver = new FakeDriver();
  const notifier = new FakeNotifier();
  const service = new ThreadGoalService(store, driver, notifier);
  return { store, driver, notifier, service };
}

describe("ThreadGoalService", () => {
  it("setGoal validates and starts a continuation turn when idle", async () => {
    const { service, driver } = makeService();
    await expect(service.setGoal("s1", "  ")).rejects.toThrow(/required/);
    const goal = await service.setGoal("s1", "做一件事", { tokenBudget: 100 });
    expect(goal.status).toBe("active");
    expect(driver.startedTurns).toHaveLength(1);
    expect(driver.startedTurns[0].input).toContain("做一件事");
    expect(driver.startedTurns[0].input).toContain('source="goal"');
  });

  it("setGoal while running injects objective-updated steering instead of starting a turn", async () => {
    const { store, service, driver } = makeService();
    await service.setGoal("s1", "旧目标");
    driver.running = true;
    driver.startedTurns.length = 0;
    const goal = await service.setGoal("s1", "新目标");
    expect(goal.objective).toBe("新目标");
    expect(driver.startedTurns).toHaveLength(0);
    expect(driver.steered).toHaveLength(1);
    expect(driver.steered[0].content).toContain("新目标");
    // 目标未变时不重复注入
    driver.steered.length = 0;
    await service.setGoal("s1", "新目标");
    expect(driver.steered).toHaveLength(0);
    expect(store.rows.get("s1")!.objective).toBe("新目标");
  });

  it("onRunSettled records usage and continues while goal stays active and within budget", async () => {
    const { store, service, driver, notifier } = makeService();
    await service.setGoal("s1", "推进", { tokenBudget: 200 });
    driver.startedTurns.length = 0;

    await service.onRunSettled({ sessionId: "s1", failed: false, tokens: 120, seconds: 10 });
    expect(store.rows.get("s1")!.tokensUsed).toBe(120);
    expect(store.rows.get("s1")!.turnCount).toBe(1);
    expect(notifier.updated.length).toBeGreaterThan(0);
    expect(driver.startedTurns).toHaveLength(1);

    // 预算耗尽：翻成 budget_limited，不再续跑
    driver.startedTurns.length = 0;
    notifier.updated.length = 0;
    await service.onRunSettled({ sessionId: "s1", failed: false, tokens: 80, seconds: 5 });
    expect(store.rows.get("s1")!.status).toBe("budget_limited");
    expect(driver.startedTurns).toHaveLength(0);
    expect(notifier.updated.some((goal) => goal.status === "budget_limited")).toBe(true);
  });

  it("does not continue after a failed run, marking usage limits when the error looks like rate limiting", async () => {
    const { store, service, driver } = makeService();
    await service.setGoal("s1", "推进");
    driver.startedTurns.length = 0;

    await service.onRunSettled({ sessionId: "s1", failed: true, usageLimited: true, tokens: 10, seconds: 1 });
    expect(store.rows.get("s1")!.status).toBe("usage_limited");
    expect(driver.startedTurns).toHaveLength(0);

    await service.setGoal("s2", "推进");
    driver.startedTurns.length = 0;
    await service.onRunSettled({ sessionId: "s2", failed: true, tokens: 10, seconds: 1 });
    expect(store.rows.get("s2")!.status).toBe("active");
    expect(driver.startedTurns).toHaveLength(0);
  });

  it("records usage for the final turn even when the model already completed the goal mid-run", async () => {
    const { store, service, driver, notifier } = makeService();
    await service.setGoal("s1", "推进");
    await service.applyModelStatusUpdate("s1", "complete");
    driver.startedTurns.length = 0;
    notifier.updated.length = 0;

    await service.onRunSettled({ sessionId: "s1", failed: false, tokens: 300, seconds: 12 });
    const goal = store.rows.get("s1")!;
    expect(goal.status).toBe("complete");
    expect(goal.tokensUsed).toBe(300);
    expect(goal.turnCount).toBe(1);
    expect(driver.startedTurns).toHaveLength(0);
    expect(notifier.updated).toHaveLength(1);
  });

  it("pause/resume manage the loop; resume kicks a turn when idle", async () => {
    const { service, driver } = makeService();
    await service.setGoal("s1", "推进");
    driver.startedTurns.length = 0;
    await service.pauseGoal("s1");
    await service.onRunSettled({ sessionId: "s1", failed: false, tokens: 5, seconds: 1 });
    expect(driver.startedTurns).toHaveLength(0);

    await service.resumeGoal("s1");
    expect(driver.startedTurns).toHaveLength(1);
    await expect(service.resumeGoal("s1")).rejects.toThrow(/Cannot transition/);
  });

  it("applyModelStatusUpdate allows only model statuses from active", async () => {
    const { store, service } = makeService();
    await service.setGoal("s1", "推进");
    await service.applyModelStatusUpdate("s1", "complete");
    expect(store.rows.get("s1")!.status).toBe("complete");

    await service.setGoal("s2", "推进");
    await expect(service.applyModelStatusUpdate("s2", "usage_limited" as never)).rejects.toThrow(/归用户和系统管理/);
    await service.pauseGoal("s2");
    await expect(service.applyModelStatusUpdate("s2", "complete")).rejects.toThrow(/Cannot transition/);
  });

  it("clearGoal removes the goal and notifies", async () => {
    const { store, service, notifier } = makeService();
    await service.setGoal("s1", "推进");
    expect(await service.clearGoal("s1")).toBe(true);
    expect(store.rows.has("s1")).toBe(false);
    expect(notifier.cleared).toBe(1);
    expect(await service.clearGoal("s1")).toBe(false);
  });

  it("resumeInterrupted restarts active goals for idle existing sessions", async () => {
    const { store, service, driver } = makeService();
    store.rows.set("s1", createThreadGoal("s1", "a"));
    store.rows.set("s2", { ...createThreadGoal("s2", "b"), status: "paused" });
    driver.exists = false; // s1 会话已不存在
    expect(await service.resumeInterrupted()).toBe(0);
    driver.exists = true;
    expect(await service.resumeInterrupted()).toBe(1);
    expect(driver.startedTurns[0].sessionId).toBe("s1");
  });

  it("notifyBudgetExhausted only steers running sessions with exhausted budget", async () => {
    const { store, service, driver } = makeService();
    store.rows.set("s1", { ...createThreadGoal("s1", "a", { tokenBudget: 10 }), status: "budget_limited" });
    driver.running = true;
    await service.notifyBudgetExhausted("s1");
    expect(driver.steered).toHaveLength(1);
    expect(driver.steered[0].content).toContain("预算已用尽");
    driver.running = false;
    await service.notifyBudgetExhausted("s1");
    expect(driver.steered).toHaveLength(1);
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeGoalBar } from "./NativeGoalBar";
import type { NativeSessionGoal } from "../global";

const goal: NativeSessionGoal = { id: "g", revision: 1, objective: "finish", phase: "active", activation: "armed", roundsStarted: 2, maxGoalRounds: 8, createdAt: 1, updatedAt: 1 };
const render = (overrides: Partial<NativeSessionGoal> = {}) => renderToStaticMarkup(createElement(NativeGoalBar, { goal: { ...goal, ...overrides }, pending: false, error: null, onMutate: async () => undefined }));
describe("Harness native goal presentation", () => {
  it("shows the native round budget and permits pause during automatic continuation", () => {
    expect(render()).toContain("2/8 轮");
    expect(render()).toContain('aria-label="暂停目标续跑"');
    expect(render()).toContain('aria-label="编辑目标"');
  });
  it("exposes resume for active disarmed and blocked goals", () => {
    expect(render({ activation: "disarmed" })).toContain("待恢复");
    expect(render({ activation: "disarmed" })).toContain('aria-label="恢复目标续跑"');
    expect(render({ phase: "blocked", activation: "disarmed", blockedReason: { code: "round-limit", message: "轮数耗尽" } })).toContain("轮数耗尽");
    expect(render({ phase: "complete" })).not.toContain('aria-label="恢复目标续跑"');
  });
});

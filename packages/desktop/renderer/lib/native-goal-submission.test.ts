import { describe, expect, it } from "vitest";
import { nativeGoalSubmission } from "./native-goal-submission";
import type { NativeSessionGoal } from "../global";

const goal: NativeSessionGoal = { id: "g", revision: 4, objective: "old", phase: "active", activation: "disarmed", roundsStarted: 2, maxGoalRounds: 10, createdAt: 1, updatedAt: 2 };
describe("Harness goal composer", () => {
  it("uses control verbs only in explicit slash commands", () => {
    expect(nativeGoalSubmission("pause", goal)).toEqual({ action: "create", objective: "pause" });
    expect(nativeGoalSubmission("/goal pause", goal)).toEqual({ action: "pause", ref: { id: "g", revision: 4 } });
    expect(nativeGoalSubmission("/goal", goal)).toBe("show");
    expect(nativeGoalSubmission("/goal edit new objective", goal)).toEqual({ action: "edit", ref: { id: "g", revision: 4 }, objective: "new objective" });
    expect(nativeGoalSubmission("/goal finish this", null)).toEqual({ action: "create", objective: "finish this" });
  });
  it("preserves an invalid draft instead of sending a control word as a model prompt", () => {
    expect(() => nativeGoalSubmission("/goal edit", goal)).toThrow("新的目标");
    expect(() => nativeGoalSubmission("/goal resume", null)).toThrow("当前没有目标");
  });
});

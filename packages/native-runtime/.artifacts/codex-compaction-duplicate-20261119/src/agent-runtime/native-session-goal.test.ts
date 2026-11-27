import { describe, expect, it } from "vitest";
import { parseNativeGoalMutation } from "./native-session-goal.js";
import { decodeHarnessGoal } from "./deepseek-harness-goal-codec.js";

describe("native goal boundary", () => {
  it.each([null, [], { action: "delete" }, { action: "create", objective: " " }, { action: "edit", ref: { id: "g", revision: 1 } }, { action: "resume", ref: { id: "g", revision: 0 } }, { action: "create", objective: "x", maxGoalRounds: 1.1 }])("rejects malformed mutations: %j", value => {
    expect(() => parseNativeGoalMutation(value)).toThrow();
  });
  it("retains exact CAS identity and normalizes the replacement fields", () => {
    expect(parseNativeGoalMutation({ action: "edit", ref: { id: "g", revision: 7 }, objective: "  changed  ", maxGoalRounds: 20 })).toEqual({ action: "edit", ref: { id: "g", revision: 7 }, objective: "changed", maxGoalRounds: 20 });
  });
  it("requires live activation, so a durable active projection cannot claim automatic continuation", () => {
    expect(() => decodeHarnessGoal({ id: "g", revision: 1, phase: "active", objective: "x", maxGoalRounds: 2, roundsStarted: 1, createdAt: 0, updatedAt: 1 })).toThrow("目标状态格式无效");
    expect(decodeHarnessGoal(undefined)).toBeNull();
  });
});

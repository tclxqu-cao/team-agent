import { describe, expect, it } from "vitest";
import { computerActionSchema } from "./computer-action.js";

describe("computerActionSchema", () => {
  const valid = [
    { action: "observe" },
    { action: "press", revision: "ax_1", nodeId: "ax_1:1" },
    { action: "click", revision: "ax_1", nodeId: "ax_1:1" },
    { action: "double_click", x: 10, y: 20 },
    { action: "type", revision: "ax_1", nodeId: "ax_1:2", text: "hello", replace: true },
    { action: "keypress", keys: ["Meta", "KeyA"] },
    { action: "scroll", revision: "ax_1", nodeId: "ax_1:3", deltaY: 120 },
    { action: "scroll", x: 10, y: 20, deltaX: 1, deltaY: -120 },
    { action: "move", x: 1, y: 2 },
    { action: "drag", startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 250 },
    { action: "wait", durationMs: 500 },
    { action: "screenshot" },
  ];

  it.each(valid)("accepts $action", (action) => {
    expect(computerActionSchema.safeParse(action).success).toBe(true);
  });

  it("rejects ambiguous and incomplete targets", () => {
    expect(computerActionSchema.safeParse({ action: "click", revision: "ax_1", nodeId: "ax_1:1", x: 1, y: 2 }).success).toBe(false);
    expect(computerActionSchema.safeParse({ action: "click", x: 1 }).success).toBe(false);
    expect(computerActionSchema.safeParse({ action: "scroll", deltaY: 1 }).success).toBe(false);
  });

  it("enforces bounded text and wait input", () => {
    expect(computerActionSchema.safeParse({ action: "type", revision: "r", nodeId: "n", text: "x".repeat(10_001) }).success).toBe(false);
    expect(computerActionSchema.safeParse({ action: "wait", durationMs: 5_001 }).success).toBe(false);
  });
});

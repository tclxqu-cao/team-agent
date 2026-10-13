import { describe, expect, it } from "vitest";
import { supportsMidTurnSteering } from "./runtime-capabilities";

describe("runtime capabilities", () => {
  it("enables steering only for runtimes with an implemented mid-turn input path", () => {
    expect(supportsMidTurnSteering("customer-agent")).toBe(true);
    expect(supportsMidTurnSteering("claude-code")).toBe(true);
    expect(supportsMidTurnSteering("codex")).toBe(true);
    expect(supportsMidTurnSteering("opencode")).toBe(true);
    expect(supportsMidTurnSteering("deepseek-harness")).toBe(true);
    expect(supportsMidTurnSteering(undefined)).toBe(false);
  });
});

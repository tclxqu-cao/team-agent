import { describe, expect, it } from "vitest";
import { canGuideExternalSession, supportsMidTurnSteering, usesNativeSessionPermissions } from "./runtime-capabilities";

describe("runtime capabilities", () => {
  it("opens external text guidance only for a verified running main-session route", () => {
    const session = { agentType: "zcode" as const, occupancy: "owned-externally" as const, status: "running" as const, externalGuideSupported: true };
    expect(canGuideExternalSession(session)).toBe(true);
    expect(canGuideExternalSession({ ...session, externalGuideSupported: false })).toBe(false);
    expect(canGuideExternalSession({ ...session, readOnly: true })).toBe(false);
    expect(canGuideExternalSession({ ...session, status: "idle" })).toBe(false);
    expect(canGuideExternalSession({ ...session, agentType: "workbuddy" })).toBe(false);
    expect(canGuideExternalSession(undefined)).toBe(false);
  });
  it("enables steering only for runtimes with an implemented mid-turn input path", () => {
    expect(supportsMidTurnSteering("customer-agent")).toBe(true);
    expect(supportsMidTurnSteering("claude-code")).toBe(true);
    expect(supportsMidTurnSteering("codex")).toBe(true);
    expect(supportsMidTurnSteering("opencode")).toBe(true);
    expect(supportsMidTurnSteering("deepseek-harness")).toBe(true);
    expect(supportsMidTurnSteering("copilot")).toBe(true);
    expect(supportsMidTurnSteering("zcode")).toBe(true);
    expect(supportsMidTurnSteering("qoder")).toBe(false);
    expect(supportsMidTurnSteering("workbuddy")).toBe(false);
    expect(supportsMidTurnSteering(undefined)).toBe(false);
  });

  it("uses the VS Code native permission policy for Copilot", () => {
    expect(usesNativeSessionPermissions("copilot")).toBe(true);
    expect(usesNativeSessionPermissions("deepseek-harness")).toBe(true);
    expect(usesNativeSessionPermissions("codex")).toBe(false);
  });
});

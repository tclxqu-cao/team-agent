import { describe, expect, it } from "vitest";
import { getSidebarSessionVisualState } from "./sidebar-session-status";

describe("getSidebarSessionVisualState", () => {
  it("shows a running session that needs input as needs-input", () => {
    expect(getSidebarSessionVisualState({
      status: "running",
      isRunning: true,
      needsInput: true,
    })).toBe("needs-input");
  });

  it("shows a running session without pending input as running", () => {
    expect(getSidebarSessionVisualState({
      status: "idle",
      isRunning: true,
      needsInput: false,
    })).toBe("running");
  });

  it.each(["idle", "completed", "aborted", "unknown"])(
    "shows a non-running %s session as completed",
    (status) => {
      expect(getSidebarSessionVisualState({
        status,
        isRunning: false,
        needsInput: false,
      })).toBe("completed");
    },
  );

  it.each(["failed", "error"])("shows %s as error even with running flags", (status) => {
    expect(getSidebarSessionVisualState({
      status,
      isRunning: true,
      needsInput: true,
    })).toBe("error");
  });
});

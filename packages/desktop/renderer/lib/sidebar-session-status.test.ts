import { describe, expect, it } from "vitest";
import { getSidebarSessionVisualState } from "./sidebar-session-status";

describe("getSidebarSessionVisualState", () => {
  it("shows a running session that needs input as needs-input", () => {
    expect(getSidebarSessionVisualState("needs-input")).toBe("needs-input");
  });

  it("shows a running session without pending input as running", () => {
    expect(getSidebarSessionVisualState("running")).toBe("running");
  });

  it("shows an idle session as completed", () => {
    expect(getSidebarSessionVisualState("idle")).toBe("completed");
  });

  it("shows an error activity as error", () => {
    expect(getSidebarSessionVisualState("error")).toBe("error");
  });

  it("shows stale remote state without an animated running indicator", () => {
    expect(getSidebarSessionVisualState("stale")).toBe("stale");
  });
});

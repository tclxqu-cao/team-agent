import { describe, expect, it } from "vitest";
import { getSidebarSessionVisualState, hasPendingSessionQuestion } from "./sidebar-session-status";

describe("getSidebarSessionVisualState", () => {
  it("does not label cancelled history cards as pending input", () => {
    const question = { questionId: "question", question: "使用形态？" };
    expect(hasPendingSessionQuestion([{ askUser: question }])).toBe(true);
    expect(hasPendingSessionQuestion([{ askUser: { ...question, answered: true } }])).toBe(false);
    expect(hasPendingSessionQuestion([{ askUser: { ...question, answered: false, cancelled: true } }])).toBe(false);
    expect(hasPendingSessionQuestion([{ askUser: { ...question, cancelled: true } }, { askUser: question }])).toBe(true);
  });
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

import { describe, expect, it, vi } from "vitest";
import { QuestionManager } from "./question-manager";

const request = {
  question: "API key?",
  toolCallId: "tc1",
};

describe("QuestionManager", () => {
  it("answers the latest pending question from a chat input", async () => {
    const emit = vi.fn();
    const manager = new QuestionManager(emit);
    const pending = manager.create(request, "session-1");

    expect(manager.answerLatest("session-1", "sk-test")).toBe(true);
    await expect(pending).resolves.toEqual({ answer: "sk-test", selectedIndices: undefined });
  });

  it("returns false when no question is pending for the session", () => {
    const manager = new QuestionManager(vi.fn());

    expect(manager.answerLatest("session-1", "hello")).toBe(false);
  });
});

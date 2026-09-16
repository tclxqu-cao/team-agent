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

  it("emits structured form fields to the renderer", async () => {
    const emit = vi.fn();
    const manager = new QuestionManager(emit);

    const pending = manager.create({
      ...request,
      fields: [
        { name: "apiKey", label: "API Key", type: "secret" },
        { name: "model", label: "模型 ID", type: "text" },
      ],
    }, "session-1");

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "ask_user",
      fields: [
        { name: "apiKey", label: "API Key", type: "secret" },
        { name: "model", label: "模型 ID", type: "text" },
      ],
    }), "session-1");
    manager.answerLatest("session-1", "submitted");
    await expect(pending).resolves.toEqual({ answer: "submitted", selectedIndices: undefined });
  });

  it("returns false when no question is pending for the session", () => {
    const manager = new QuestionManager(vi.fn());

    expect(manager.answerLatest("session-1", "hello")).toBe(false);
  });

  it("keeps a question pending until it is answered", async () => {
    vi.useFakeTimers();
    const manager = new QuestionManager(vi.fn());
    const pending = manager.create(request, "session-1");

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(manager.answerLatest("session-1", "still here")).toBe(true);
    await expect(pending).resolves.toEqual({ answer: "still here", selectedIndices: undefined });
    vi.useRealTimers();
  });
});

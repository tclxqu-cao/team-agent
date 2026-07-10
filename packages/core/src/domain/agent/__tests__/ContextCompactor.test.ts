import { describe, expect, it } from "vitest";
import { ContextCompactor } from "../ContextCompactor.js";
import type { IModelProvider, Message, StreamEvent } from "../../model/entities.js";

function createMockModel(summary = "handoff summary"): IModelProvider {
  return {
    providerId: "mock",
    modelId: "mock-model",
    streamChat: async function* (): AsyncIterable<StreamEvent> {
      yield { type: "text_chunk", text: summary };
      yield { type: "text_done" };
    },
    countTokens: async (messages: Message[]) =>
      messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 4), 0),
    supportsModel: () => true,
  };
}

describe("ContextCompactor", () => {
  it("compacts a session into recent user messages plus a handoff summary", async () => {
    const compactor = new ContextCompactor(createMockModel());
    const result = await compactor.compactForHandoff([
      { role: "user", content: "first request" },
      { role: "assistant", content: "first response" },
      { role: "tool", content: "large tool output", name: "read_file" },
      { role: "user", content: "latest instruction" },
    ]);

    expect(result.summary).toBe("handoff summary");
    expect(result.replacementMessages).toHaveLength(3);
    expect(result.replacementMessages[0]).toMatchObject({ role: "user", content: "first request" });
    expect(result.replacementMessages[1]).toMatchObject({ role: "user", content: "latest instruction" });
    expect(result.replacementMessages[2].content).toContain("This is a summary of the conversation so far");
    expect(result.replacementMessages[2].content).toContain("handoff summary");
    expect(result.replacementMessages.some((message) => message.role === "tool")).toBe(false);
  });
});

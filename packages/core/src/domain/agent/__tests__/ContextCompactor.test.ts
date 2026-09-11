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
  it("keeps history when summarization returns no text", async () => {
    const messages: Message[] = [{ role: "system", content: "rules" }, { role: "user", content: "earlier" }, { role: "user", content: "latest" }];
    expect((await new ContextCompactor(createMockModel("")).compact(messages, 1, 8192)).messages).toEqual(messages);
  });

  it("bounds the summarizer request and preserves the current instruction with short history", async () => {
    const model = createMockModel();
    model.streamChat = async function* (messages, options) {
      expect(messages[1].content.length).toBeLessThan(7000);
      expect(options?.maxTokens).toBe(1024);
      yield { type: "text_chunk", text: "Earlier progress" };
    };
    const messages: Message[] = [{ role: "system", content: "rules" },
      ...Array.from({ length: 5 }, () => ({ role: "user" as const, content: "中文".repeat(4000) })),
      { role: "user", content: "latest instruction" }];
    const result = await new ContextCompactor(model).compact(messages, 1, 8192);
    expect(result.removedMessages).toBe(5);
    expect(result.messages.at(-1)?.content).toBe("latest instruction");
  });
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

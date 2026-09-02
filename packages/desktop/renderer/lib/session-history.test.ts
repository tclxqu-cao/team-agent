import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import { mergeRefreshedSessionHistory, restoreSessionHistoryPage } from "./session-history";

describe("restoreSessionHistoryPage", () => {
  it("merges tool results in linear lookup order", () => {
    const restored = restoreSessionHistoryPage({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }],
        },
        { role: "tool", content: "/tmp", toolCallId: "call-1" },
      ],
      events: [],
    });

    expect(restored).toHaveLength(1);
    expect(restored[0].toolCalls?.[0].result).toBe("/tmp");
  });

  it("restores event-only assistant output when persisted messages are incomplete", () => {
    const restored = restoreSessionHistoryPage({
      messages: [{ role: "user", content: "run" }],
      events: [
        { type: "text_chunk", text: "done" },
        { type: "tool_call", toolCall: { id: "call-1", name: "shell", arguments: {} } },
        { type: "tool_result", result: { toolCallId: "call-1", content: "ok" } },
      ],
    });

    expect(restored.map((message) => message.content)).toEqual(["run", "done"]);
    expect(restored[1].toolCalls?.[0].result).toBe("ok");
  });

  it("restores one unresolved approval card from the persisted native event stream", () => {
    const restored = restoreSessionHistoryPage({
      messages: [{ role: "user", content: "deploy" }],
      events: [
        {
          type: "ask_user",
          questionId: "native:run-1:42",
          question: "Approve deployment?",
          options: [{ label: "允许一次", description: "once" }],
        },
      ],
    });

    expect(restored.filter((message) => message.askUser)).toEqual([
      expect.objectContaining({ askUser: expect.objectContaining({ questionId: "native:run-1:42" }) }),
    ]);
  });
});

function message(id: string, content: string): ChatMessage {
  return { id, role: "user", content, timestamp: 1 };
}

describe("mergeRefreshedSessionHistory", () => {
  it("preserves loaded older pages and replaces the overlapping latest tail", () => {
    const current = ["old-1", "old-2", "tail-1", "tail-2"].map((content) => message(content, content));
    const refreshed = [message("new-tail-1", "tail-1"), message("new-tail-2", "tail-2 updated")];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.map((entry) => entry.content)).toEqual(["old-1", "old-2", "tail-1", "tail-2 updated"]);
    expect(merged[2].id).toBe("tail-1");
  });

  it("keeps the message that just moved beyond the refreshed page boundary", () => {
    const current = ["old", "boundary", "shared-1", "shared-2"].map((content) => message(content, content));
    const refreshed = [message("fresh-1", "shared-1"), message("fresh-2", "shared-2"), message("fresh-3", "new")];

    expect(mergeRefreshedSessionHistory(current, refreshed).map((entry) => entry.content)).toEqual([
      "old",
      "boundary",
      "shared-1",
      "shared-2",
      "new",
    ]);
  });

  it("does not erase visible history when a partial transcript yields no messages", () => {
    const current = [message("existing", "existing")];
    expect(mergeRefreshedSessionHistory(current, [])).toBe(current);
  });
});

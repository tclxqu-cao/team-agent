import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import { mergeRefreshedSessionHistory, restoreSessionHistoryPage } from "./session-history";

describe("restoreSessionHistoryPage", () => {
  it("preserves the stable history identity used by query navigation", () => {
    const [restored] = restoreSessionHistoryPage({
      messages: [{ historyId: "history-message.v1.rev.1", role: "user", content: "jump here" }],
      events: [],
    });

    expect(restored.id).toBe("history-message.v1.rev.1");
  });

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

  it("keeps native projection identity internal instead of rendering it as an agent name", () => {
    const [restored] = restoreSessionHistoryPage({
      messages: [{
        role: "user",
        content: "long-running goal",
        name: "__native_run:run-1",
      }],
      events: [],
    });

    expect(restored).toMatchObject({
      role: "user",
      content: "long-running goal",
      name: "__native_run:run-1",
    });
    expect(restored.agentName).toBeUndefined();
  });
});

function message(id: string, content: string): ChatMessage {
  return { id, role: "user", content, timestamp: 1 };
}

function assistant(id: string, content: string, toolCalls?: ChatMessage["toolCalls"]): ChatMessage {
  return { id, role: "assistant", content, toolCalls, timestamp: 1 };
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

  it("keeps queued messages after a native history tail refresh", () => {
    const current = [
      message("history", "working"),
      { ...message("queued", "follow up"), isQueued: true, queueItemId: "queue-1" },
    ];

    expect(mergeRefreshedSessionHistory(current, [message("fresh", "working")])).toEqual([
      expect.objectContaining({ id: "history", content: "working" }),
      current[1],
    ]);
  });

  it("replaces one live turn when persisted history groups its tools differently", () => {
    const current = [
      message("old-user", "earlier"),
      assistant("old-assistant", "earlier response"),
      message("live-user", "run"),
      assistant("live-tool", "", [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }]),
      assistant("live-final", "done"),
    ];
    const refreshed = [
      { ...message("persisted-user", "run"), name: "__native_run:run-1" },
      assistant("persisted-final", "done", [{
        id: "call-1",
        name: "shell",
        arguments: { command: "pwd" },
        result: "/workspace",
      }]),
    ];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.map((entry) => [entry.role, entry.content])).toEqual([
      ["user", "earlier"],
      ["assistant", "earlier response"],
      ["user", "run"],
      ["assistant", "done"],
    ]);
    expect(merged.filter((entry) => entry.role === "assistant" && entry.content === "done")).toHaveLength(1);
    expect(merged[2].id).toBe("live-user");
    expect(merged.at(-1)?.toolCalls?.[0].result).toBe("/workspace");
  });

  it("preserves identical text in separate turns", () => {
    const current = [
      message("first-user", "repeat"),
      assistant("first-assistant", "same answer"),
      message("second-user", "repeat"),
      assistant("second-assistant", "same answer"),
    ];
    const refreshed = [
      message("persisted-user", "repeat"),
      assistant("persisted-assistant", "same answer"),
    ];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.map((entry) => [entry.role, entry.content])).toEqual([
      ["user", "repeat"],
      ["assistant", "same answer"],
      ["user", "repeat"],
      ["assistant", "same answer"],
    ]);
    expect(merged[0].id).toBe("first-user");
    expect(merged[2].id).toBe("second-user");
  });

  it("does not use an unsent queued message as a persisted turn boundary", () => {
    const queued = { ...message("queued", "repeat"), isQueued: true, queueItemId: "queue-1" };
    const current = [
      message("live-user", "repeat"),
      assistant("live-assistant", "live answer"),
      queued,
    ];
    const refreshed = [
      message("persisted-user", "repeat"),
      assistant("persisted-assistant", "persisted answer"),
    ];

    const merged = mergeRefreshedSessionHistory(current, refreshed);

    expect(merged.map((entry) => entry.content)).toEqual(["repeat", "persisted answer", "repeat"]);
    expect(merged.at(-1)).toBe(queued);
  });

  it("keeps optimistic images while refreshed history has no usable attachment", () => {
    const image = "data:image/png;base64,AAAA";
    const optimistic = { ...message("optimistic", "inspect"), images: [image] };
    const refreshed = message("refreshed", "inspect");

    expect(mergeRefreshedSessionHistory([optimistic], [refreshed])).toEqual([{
      ...refreshed,
      id: optimistic.id,
      timestamp: optimistic.timestamp,
      images: [image],
    }]);
  });

  it("switches from optimistic images to usable persisted attachments", () => {
    const image = "data:image/png;base64,AAAA";
    const optimistic = { ...message("optimistic", "inspect"), images: [image] };
    const refreshed = {
      ...message("refreshed", "inspect"),
      presentation: {
        attachments: [{ type: "image" as const, name: "image-1.png", dataUrl: image }],
      },
    };

    const merged = mergeRefreshedSessionHistory([optimistic], [refreshed]);

    expect(merged[0]).toMatchObject({
      id: optimistic.id,
      presentation: refreshed.presentation,
    });
    expect(merged[0].images).toBeUndefined();
  });
});

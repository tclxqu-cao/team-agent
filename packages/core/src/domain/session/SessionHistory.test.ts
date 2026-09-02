import { describe, expect, it } from "vitest";
import type { Message } from "../model/entities.js";
import { paginateSessionHistory } from "./SessionHistory.js";

describe("paginateSessionHistory", () => {
  const messages: Message[] = [
    { role: "user", content: "one" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tool-1", name: "shell", arguments: { command: "pwd" } }],
    },
    { role: "tool", content: "/tmp", toolCallId: "tool-1" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
    { role: "assistant", content: "four" },
  ];

  it("loads the latest visible items and keeps tool results with their call", () => {
    const page = paginateSessionHistory(messages, [], { limit: 3 });

    expect(page.messages.map((message) => message.content)).toEqual(["two", "three", "four"]);
    expect(page.history).toEqual({
      nextCursor: "history.v1.2",
      hasMore: true,
      pageSize: 3,
      totalItems: 5,
    });
  });

  it("uses the cursor to load older items without splitting a tool result", () => {
    const page = paginateSessionHistory(messages, [], {
      before: "history.v1.3",
      limit: 2,
    });

    expect(page.messages.map((message) => [message.role, message.content])).toEqual([
      ["assistant", ""],
      ["tool", "/tmp"],
      ["assistant", "two"],
    ]);
    expect(page.history.nextCursor).toBe("history.v1.1");
  });

  it("clamps invalid page sizes and cursors", () => {
    const page = paginateSessionHistory(messages, [], {
      before: "invalid",
      limit: 0,
    });

    expect(page.messages).toEqual([{ role: "assistant", content: "four" }]);
    expect(page.history.pageSize).toBe(1);
  });

  it("keeps the latest native subagent activity beside its parent Agent call", () => {
    const agentMessages: Message[] = [{
      role: "assistant",
      content: "",
      toolCalls: [{ id: "agent-tool", name: "Agent", arguments: { prompt: "inspect" } }],
    }];
    const activity = {
      taskId: "task-1",
      parentToolCallId: "agent-tool",
      description: "inspect",
      status: "completed" as const,
      messages: [{ role: "assistant" as const, content: "done" }],
    };

    const page = paginateSessionHistory(agentMessages, [
      { type: "native_subagent_update", activity: { ...activity, status: "running" } },
      { type: "native_subagent_update", activity },
    ]);

    expect(page.events).toEqual([{ type: "native_subagent_update", activity }]);
  });
});

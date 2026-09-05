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

  it("loads a complete latest turn when the page starts at a user boundary", () => {
    const page = paginateSessionHistory(messages, [], { limit: 2 });

    expect(page.messages.map((message) => message.content)).toEqual(["three", "four"]);
    expect(page.history).toMatchObject({
      nextCursor: "history.v1.3",
      hasMore: true,
      pageSize: 2,
      totalItems: 5,
    });
  });

  it("rewinds an older page to its user boundary and keeps tool results attached", () => {
    const page = paginateSessionHistory(messages, [], {
      before: "history.v1.3",
      limit: 2,
    });

    expect(page.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "one"],
      ["assistant", ""],
      ["tool", "/tmp"],
      ["assistant", "two"],
    ]);
    expect(page.history).toMatchObject({ nextCursor: null, hasMore: false, pageSize: 3 });
  });

  it("clamps invalid page sizes and cursors", () => {
    const page = paginateSessionHistory(messages, [], {
      before: "invalid",
      limit: 0,
    });

    expect(page.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "three" },
      { role: "assistant", content: "four" },
    ]);
    expect(page.history.pageSize).toBe(2);
  });

  it("expands a 50-item page to include the user boundary of a 54-item turn", () => {
    const longTurn: Message[] = [
      { role: "user", content: "older" },
      { role: "assistant", content: "older response" },
      { role: "user", content: "run" },
      ...Array.from({ length: 53 }, (_, index): Message => ({
        role: "assistant",
        content: `update-${index + 1}`,
      })),
      {
        role: "assistant",
        content: "final",
        toolCalls: [{ id: "tool-long", name: "shell", arguments: { command: "pwd" } }],
      },
      { role: "tool", content: "/workspace", toolCallId: "tool-long" },
    ];

    const latest = paginateSessionHistory(longTurn, [], { limit: 50 });
    const older = paginateSessionHistory(longTurn, [], {
      before: latest.history.nextCursor ?? undefined,
      limit: 50,
    });

    expect(latest.messages[0]).toMatchObject({ role: "user", content: "run" });
    expect(latest.messages.at(-1)).toEqual({ role: "tool", content: "/workspace", toolCallId: "tool-long" });
    expect(latest.history).toMatchObject({
      nextCursor: "history.v1.2",
      hasMore: true,
      pageSize: 55,
      totalItems: 57,
    });
    expect(older.messages.map((message) => message.content)).toEqual(["older", "older response"]);
    expect([...older.messages, ...latest.messages].filter((message) => message.role !== "tool")).toHaveLength(57);
  });

  it("starts at zero for legacy assistant-only history", () => {
    const legacy = Array.from({ length: 60 }, (_, index): Message => ({
      role: "assistant",
      content: `legacy-${index}`,
    }));

    const page = paginateSessionHistory(legacy, [], { limit: 50 });

    expect(page.messages.map(({ role, content }) => ({ role, content }))).toEqual(legacy);
    expect(page.history).toMatchObject({
      nextCursor: null,
      hasMore: false,
      pageSize: 60,
      totalItems: 60,
    });
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

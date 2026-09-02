import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import { messageActionPolicy } from "./message-actions";

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, role, content, timestamp: 1, ...extra };
}

describe("messageActionPolicy", () => {
  it("gives user messages copy only", () => {
    expect(messageActionPolicy([message("u1", "user", "hello")], 0, false)).toEqual({
      showCopy: true,
      showSpeak: false,
      compact: false,
    });
  });

  it("keeps intermediate assistant text actionless and compact", () => {
    const messages = [
      message("u1", "user", "inspect"),
      message("a1", "assistant", "I am checking the files."),
      message("t1", "assistant", "", {
        toolCalls: [{ id: "call-1", name: "read_file", arguments: {} }],
      }),
      message("a2", "assistant", "Done."),
    ];

    expect(messageActionPolicy(messages, 1, false)).toEqual({
      showCopy: false,
      showSpeak: false,
      compact: true,
    });
  });

  it("gives a completed final assistant response speech and copy", () => {
    const messages = [
      message("u1", "user", "first"),
      message("a1", "assistant", "First answer."),
      message("u2", "user", "second"),
    ];

    expect(messageActionPolicy(messages, 1, true)).toEqual({
      showCopy: true,
      showSpeak: true,
      compact: false,
    });
  });

  it("waits for the active turn to complete before exposing final actions", () => {
    const messages = [
      message("u1", "user", "inspect"),
      message("a1", "assistant", "Final text is still streaming."),
    ];

    expect(messageActionPolicy(messages, 1, true)).toEqual({
      showCopy: false,
      showSpeak: false,
      compact: true,
    });
    expect(messageActionPolicy(messages, 1, false)).toEqual({
      showCopy: true,
      showSpeak: true,
      compact: false,
    });
  });

  it("does not treat a text and tool message as the final response", () => {
    const messages = [
      message("u1", "user", "inspect"),
      message("a1", "assistant", "I will run this now.", {
        toolCalls: [{ id: "call-1", name: "exec", arguments: {} }],
      }),
    ];

    expect(messageActionPolicy(messages, 1, false)).toEqual({
      showCopy: false,
      showSpeak: false,
      compact: true,
    });
  });

  it("does not let a steered message complete the active assistant turn", () => {
    const messages = [
      message("u1", "user", "inspect"),
      message("a1", "assistant", "Still working."),
      message("u2", "user", "also check tests", { isSteered: true }),
    ];

    expect(messageActionPolicy(messages, 1, true).showCopy).toBe(false);
  });
});

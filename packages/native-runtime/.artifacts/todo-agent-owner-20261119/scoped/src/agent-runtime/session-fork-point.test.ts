import { describe, expect, it } from "vitest";
import type { Message } from "@agent/core";
import { completedForkMessageIndex, parseSessionForkPoint } from "./session-fork-point.js";

const transcript: Message[] = [
  { role: "user", content: "first" },
  { role: "assistant", content: "answer 1", presentation: { forkPoint: { messageId: "a1" } } },
  { role: "user", content: "second" },
  { role: "assistant", content: "progress", presentation: { forkPoint: { messageId: "progress" } } },
  { role: "assistant", content: "answer 2", presentation: { forkPoint: { messageId: "a2" } } },
];

describe("completed fork points", () => {
  it("accepts an earlier completed turn while the following turn is running", () => {
    expect(completedForkMessageIndex(transcript, "a1", true)).toBe(1);
  });
  it("accepts the inclusive final message of an idle transcript", () => {
    expect(completedForkMessageIndex(transcript, "a2", false)).toBe(4);
  });
  it.each(["missing", "progress"])("rejects %s without silently copying the full transcript", (id) => {
    expect(() => completedForkMessageIndex(transcript, id, false)).toThrow();
  });
  it("rejects the current unfinished turn", () => {
    expect(() => completedForkMessageIndex(transcript, "a2", true)).toThrow();
  });
  it.each([null, {}, { turnId: "" }, { turnId: "a", messageId: "b" }, { messageId: 3 }])("rejects malformed point %j", (point) => {
    expect(() => parseSessionForkPoint(point)).toThrow();
  });
});

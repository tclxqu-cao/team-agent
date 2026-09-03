import { describe, expect, it } from "vitest";
import { moveQueuedMessage } from "./queued-message-order";

describe("moveQueuedMessage", () => {
  it("moves a queued message to the selected queue position", () => {
    const messages = [
      { id: "history" },
      { id: "first", isQueued: true },
      { id: "second", isQueued: true },
      { id: "third", isQueued: true },
    ];

    expect(moveQueuedMessage(messages, "first", "third").map((message) => message.id)).toEqual([
      "history",
      "second",
      "third",
      "first",
    ]);
  });

  it("keeps non-queued history in its original slots", () => {
    const messages = [
      { id: "queued-a", isQueued: true },
      { id: "assistant-history" },
      { id: "queued-b", isQueued: true },
    ];

    expect(moveQueuedMessage(messages, "queued-b", "queued-a").map((message) => message.id)).toEqual([
      "queued-b",
      "assistant-history",
      "queued-a",
    ]);
  });

  it("returns the same collection when either queued message is missing", () => {
    const messages = [{ id: "queued", isQueued: true }];
    expect(moveQueuedMessage(messages, "queued", "missing")).toBe(messages);
  });
});

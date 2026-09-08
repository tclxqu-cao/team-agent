import { describe, expect, it } from "vitest";
import {
  findLatestUnqueuedUserMessageId,
  hideQueuedGoalMessages,
  moveQueuedMessage,
  projectSessionGoals,
  queuedSessionMessages,
  reconcileDurableQueuedMessages,
} from "./queued-message-order";

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

describe("findLatestUnqueuedUserMessageId", () => {
  it("selects the optimistic message that collided with an existing run", () => {
    expect(findLatestUnqueuedUserMessageId([
      { id: "earlier-user", role: "user" },
      { id: "assistant", role: "assistant" },
      { id: "queued", role: "user", isQueued: true },
      { id: "latest-user", role: "user" },
    ])).toBe("latest-user");
  });

  it("returns null when no unqueued user message exists", () => {
    expect(findLatestUnqueuedUserMessageId([
      { id: "assistant", role: "assistant" },
      { id: "queued", role: "user", isQueued: true },
    ])).toBeNull();
  });
});

describe("hideQueuedGoalMessages", () => {
  it("hides only messages linked to queued goals", () => {
    const active = { id: "active-message", role: "user" };
    const queued = { id: "queued-message", role: "user" };
    const ordinary = { id: "ordinary-message", role: "user" };

    expect(hideQueuedGoalMessages([active, queued, ordinary], [
      { sourceMessageId: queued.id },
    ])).toEqual([active, ordinary]);
  });

  it("keeps the original collection when queued goals have no linked message", () => {
    const messages = [{ id: "active-message" }, { id: "history-message" }];

    expect(hideQueuedGoalMessages(messages, [{}])).toBe(messages);
    expect(hideQueuedGoalMessages(messages, [{ sourceMessageId: "missing" }])).toEqual(messages);
  });
});

describe("reconcileDurableQueuedMessages", () => {
  it("projects an immediately active durable message exactly once", () => {
    const result = reconcileDurableQueuedMessages([], {
      active: {
        id: "queue-1",
        sourceMessageId: "source-1",
        objective: "deploy",
        createdAt: 3,
        kind: "message",
      },
      queued: [],
      history: [],
    });

    expect(result).toEqual([expect.objectContaining({
      id: "source-1",
      role: "user",
      content: "deploy",
      isQueued: false,
    })]);
  });

  it("replaces only queued messages from the durable broker snapshot", () => {
    const current = [
      { id: "history", role: "assistant", content: "working", timestamp: 1 },
      { id: "local", role: "user", content: "old", timestamp: 2, isQueued: true, queueItemId: "queue-1" },
    ];

    expect(reconcileDurableQueuedMessages(current, {
      active: null,
      queued: [{
        id: "queue-1",
        sourceMessageId: "source-1",
        objective: "edited",
        createdAt: 3,
        kind: "message",
        messagePayload: { agentName: "reviewer", images: ["data:image/png;base64,AAAA"] },
      }],
      history: [],
    })).toEqual([
      current[0],
      expect.objectContaining({
        id: "source-1",
        content: "edited",
        timestamp: 2,
        isQueued: true,
        queueItemId: "queue-1",
      }),
    ]);
  });

  it("moves a durable queue item into chat history after the broker claims it", () => {
    const current = [
      { id: "history", role: "assistant", content: "done", timestamp: 1 },
      {
        id: "source-1",
        role: "user",
        content: "next",
        timestamp: 2,
        images: ["data:image/png;base64,AAAA"],
        isQueued: true,
        queueItemId: "queue-1",
      },
    ];

    expect(reconcileDurableQueuedMessages(current, {
      active: {
        id: "queue-1",
        sourceMessageId: "source-1",
        objective: "next",
        createdAt: 3,
        kind: "message",
      },
      queued: [],
      history: [],
    })).toEqual([
      current[0],
      expect.objectContaining({
        id: "source-1",
        content: "next",
        timestamp: 2,
        images: ["data:image/png;base64,AAAA"],
        isQueued: false,
        queueItemId: undefined,
      }),
    ]);
  });

  it("reuses the latest matching transcript user message for an active queue item", () => {
    const current = [
      { id: "earlier-same", role: "user", content: "next", timestamp: 1 },
      { id: "history", role: "assistant", content: "done", timestamp: 2 },
      {
        id: "persisted-active",
        role: "user",
        content: "next",
        timestamp: 4,
      },
    ];

    const result = reconcileDurableQueuedMessages(current, {
      active: {
        id: "queue-1",
        sourceMessageId: "source-1",
        objective: "next",
        createdAt: 3,
        kind: "message",
      },
      queued: [],
      history: [],
    });

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("earlier-same");
    expect(result[2]).toEqual(expect.objectContaining({
      id: "persisted-active",
      content: "next",
      isQueued: false,
    }));
  });

  it("keeps a completed active message as ordinary history", () => {
    const completed = { id: "source-1", role: "user", content: "next", timestamp: 2, isQueued: false };

    expect(reconcileDurableQueuedMessages([completed], {
      active: null,
      queued: [],
      history: [],
    })).toEqual([completed]);
  });
});

describe("mixed queue projections", () => {
  const goal = { id: "goal", objective: "goal", createdAt: 1, kind: "goal" as const };
  const legacyGoal = { id: "legacy", objective: "legacy", createdAt: 2 };
  const message = { id: "message", objective: "message", createdAt: 3, kind: "message" as const };
  const state = { active: message, queued: [goal, message], history: [legacyGoal, message] };

  it("projects waiting durable messages for chat bubbles", () => {
    expect(queuedSessionMessages(state)).toEqual([message]);
  });

  it("projects goals without exposing active or historical messages", () => {
    expect(projectSessionGoals(state)).toEqual({
      active: null,
      queued: [goal],
      history: [legacyGoal],
    });
  });
});

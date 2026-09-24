import { describe, expect, it } from "vitest";
import {
  findLatestPendingUserMessageId,
  findLatestUnqueuedUserMessageId,
  hideQueuedGoalMessages,
  markDurableMessageSteered,
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

describe("findLatestPendingUserMessageId", () => {
  it("selects only the latest pending user message outside the queue", () => {
    expect(findLatestPendingUserMessageId([
      { id: "pending-earlier", role: "user", sendState: "pending" },
      { id: "failed", role: "user", sendState: "failed" },
      { id: "queued", role: "user", sendState: "pending", isQueued: true },
      { id: "pending-latest", role: "user", sendState: "pending" },
    ])).toBe("pending-latest");
  });

  it("returns null when no user message is awaiting admission", () => {
    expect(findLatestPendingUserMessageId([
      { id: "assistant", role: "assistant", sendState: "pending" },
      { id: "failed", role: "user", sendState: "failed" },
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

describe("markDurableMessageSteered", () => {
  it("keeps an accepted durable steer visible as ordinary chat history", () => {
    const unrelated = { id: "history", role: "assistant", content: "working", timestamp: 1 };
    const queued = {
      id: "source-1",
      role: "user",
      content: "guide the active turn",
      timestamp: 2,
      isQueued: true,
      queueItemId: "queue-1",
      sendState: "pending" as const,
    };

    const result = markDurableMessageSteered([unrelated, queued], queued.id);

    expect(result[0]).toBe(unrelated);
    expect(result[1]).toEqual({
      ...queued,
      isQueued: false,
      isSteered: true,
      queueItemId: undefined,
      sendState: undefined,
    });
    expect(reconcileDurableQueuedMessages(result, {
      active: null,
      queued: [],
      history: [],
    })).toEqual(result);
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
      sendState: "pending",
    })]);
  });

  it("replaces only queued messages from the durable broker snapshot", () => {
    const current = [
      { id: "history", role: "assistant", content: "working", timestamp: 1 },
      { id: "local", role: "user", content: "old", timestamp: 2, isQueued: true, queueItemId: "queue-1" },
    ];

    const result = reconcileDurableQueuedMessages(current, {
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
    });

    expect(result).toEqual([
      current[0],
      expect.objectContaining({
        id: "source-1",
        content: "edited",
        timestamp: 2,
        isQueued: true,
        queueItemId: "queue-1",
      }),
    ]);
    expect(result[1]).not.toHaveProperty("sendState");
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
        sendState: "pending",
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
      sendState: "pending",
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

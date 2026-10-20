import { describe, expect, it } from "vitest";
import { mergeProgressiveSessionHistoryPage, restoreSessionHistoryPage } from "./session-history";
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
  it("moves an accepted durable steer to the current history tail", () => {
    const unrelated = { id: "history", role: "assistant", content: "working", timestamp: 1 };
    const later = { id: "later", role: "assistant", content: "still working", timestamp: 3 };
    const queued = {
      id: "source-1",
      role: "user",
      content: "guide the active turn",
      timestamp: 2,
      isQueued: true,
      queueItemId: "queue-1",
      sendState: "pending" as const,
    };

    const result = markDurableMessageSteered([unrelated, queued, later], queued.id, 4);

    expect(result[0]).toBe(unrelated);
    expect(result[1]).toBe(later);
    expect(result[2]).toEqual({
      ...queued,
      timestamp: 4,
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

  it("keeps the original collection when the queued message is already gone", () => {
    const messages = [{ id: "history", role: "assistant", content: "working", timestamp: 1 }];
    expect(markDurableMessageSteered(messages, "missing", 2)).toBe(messages);
  });

  it("does not restore an accepted steer from a late queue snapshot, preserving equal new input", () => {
    const accepted = {
      id: "source-accepted", role: "user", content: "same input", timestamp: 2,
      isQueued: false, isSteered: true,
    };
    const stale = {
      active: null,
      queued: [
        { id: "queue-old", sourceMessageId: accepted.id, objective: accepted.content, createdAt: 1, kind: "message" as const },
        { id: "queue-new", sourceMessageId: "source-new", objective: accepted.content, createdAt: 3, kind: "message" as const },
      ],
      history: [],
    };
    const result = reconcileDurableQueuedMessages([accepted], stale);
    expect(result.filter((message) => message.isQueued).map((message) => message.id)).toEqual(["source-new"]);
    expect(result[0]).toEqual(accepted);
    expect(reconcileDurableQueuedMessages(result, stale)).toEqual(result);
  });

  it("does not regress accepted steering when an older snapshot still has the item active", () => {
    const accepted = {
      id: "source-accepted", role: "user", content: "same input", timestamp: 2,
      isQueued: false, isSteered: true,
    };
    expect(reconcileDurableQueuedMessages([accepted], {
      active: { id: "queue-old", sourceMessageId: accepted.id, objective: accepted.content, createdAt: 1, kind: "message" },
      queued: [], history: [],
    })).toEqual([accepted]);
  });
});

describe("reconcileDurableQueuedMessages", () => {
  it("retains an optimistic queued input across a snapshot taken before enqueue acknowledgement", () => {
    const input = { id: "saving", role: "user", content: "next", timestamp: 2, isQueued: true };
    expect(reconcileDurableQueuedMessages([input], { active: null, queued: [], history: [] })).toEqual([input]);
  });

  it("does not resurrect a cancelled queue item", () => {
    const input = { id: "source", role: "user", content: "cancelled", timestamp: 2, isQueued: true, queueItemId: "queue" };
    expect(reconcileDurableQueuedMessages([input], { active: null, queued: [], history: [{ id: "queue", sourceMessageId: "source", objective: "cancelled", createdAt: 2, kind: "message", status: "cancelled" }] })).toEqual([]);
  });

  it("keeps the user bubble before its reply when a queued turn finishes between snapshots", () => {
    const input = { id: "source", role: "user", content: "啥问题 超时", timestamp: 2, isQueued: true, queueItemId: "queue" };
    const reply = { id: "reply", role: "assistant", content: "是事务超时", timestamp: 3 };
    const result = reconcileDurableQueuedMessages([input, reply], {
      active: null, queued: [], history: [{ id: "queue", sourceMessageId: "source", kind: "message", status: "completed", objective: input.content, createdAt: 2 }],
    });
    expect(result.map(message => message.id)).toEqual(["source", "reply"]);
    expect(result[0].isQueued).toBe(false);
    expect(reconcileDurableQueuedMessages(result, { active: null, queued: [], history: [] })).toEqual(result);
  });

  const activeMessageState = {
    active: {
      id: "queue-active",
      sourceMessageId: "source-active",
      objective: "deploy",
      createdAt: 3,
      kind: "message" as const,
    },
    queued: [],
    history: [],
  };
  const coreHistory = { delivery: "core" as const, revision: "rev-1" };
  const steeringTurn = () => restoreSessionHistoryPage({
    history: coreHistory,
    messages: [
      {
        historyId: "history-active",
        role: "user",
        content: "deploy",
        presentation: { executionTrace: { turnId: "turn-active", segmentIndex: 0 } },
      },
      ...[1, 2].map((segmentIndex) => ({
        historyId: `history-steering-${segmentIndex}`,
        role: "user",
        content: "also fix ask",
        presentation: { executionTrace: { turnId: "turn-active", segmentIndex } },
      })),
    ],
  });

  it("reuses the active turn's initial input after repeated steering inputs", () => {
    const current = steeringTurn();
    const result = reconcileDurableQueuedMessages(current, activeMessageState);

    expect(result.map((message) => message.id)).toEqual(current.map((message) => message.id));
    expect(result.filter((message) => message.role === "user").map((message) => message.content))
      .toEqual(["deploy", "also fix ask", "also fix ask"]);
    expect(result[0]).not.toHaveProperty("sendState");
  });

  it("repairs an already appended source copy without dropping steering or attachments", () => {
    const current = steeringTurn();
    const source = {
      id: "source-active",
      role: "user" as const,
      content: "deploy",
      timestamp: 3,
      images: ["data:image/png;base64,AAAA"],
      isQueued: false,
    };
    const polluted = [...current, source];
    const result = reconcileDurableQueuedMessages(polluted, activeMessageState);

    expect(result.map((message) => message.id)).toEqual(current.map((message) => message.id));
    expect(result[0].images).toEqual(source.images);
    expect(result[0].presentation).toEqual(current[0].presentation);
    expect(polluted.at(-1)).toBe(source);
  });

  it("keeps queue agent metadata when the native transcript omits it", () => {
    const current = steeringTurn();
    const state = {
      ...activeMessageState,
      active: { ...activeMessageState.active, messagePayload: { agentName: "reviewer" } },
    };
    const result = reconcileDurableQueuedMessages(current, state);

    expect(result.map((message) => message.id)).toEqual(current.map((message) => message.id));
    expect(result[0].agentName).toBe("reviewer");
  });

  it("keeps the repaired order through successive core and queue refreshes", () => {
    const core = steeringTurn();
    let current = [...core, {
      id: "source-active",
      role: "user" as const,
      content: "deploy",
      timestamp: 3,
      isQueued: false,
    }];
    for (let refresh = 0; refresh < 3; refresh += 1) {
      current = reconcileDurableQueuedMessages(
        mergeProgressiveSessionHistoryPage(current, core, "core", coreHistory),
        activeMessageState,
      );
      expect(current.map((message) => message.id)).toEqual(core.map((message) => message.id));
    }
  });

  it("preserves equal inputs from earlier turns and steering within the active turn", () => {
    const current = steeringTurn();
    const repeatedSteering = { ...current[2], content: "deploy" };
    const earlier = {
      ...current[0],
      id: "history-earlier",
      presentation: { executionTrace: { turnId: "turn-earlier", segmentIndex: 0 } },
    };
    const transcript = [earlier, current[0], current[1], repeatedSteering, ...current.slice(3)];
    const result = reconcileDurableQueuedMessages(transcript, activeMessageState);

    expect(result.map((message) => message.id)).toEqual(transcript.map((message) => message.id));
    expect(result.filter((message) => message.role === "user" && message.content === "deploy"))
      .toHaveLength(3);
  });

  it("does not confuse a completed turn with a new equal active input", () => {
    const current = steeringTurn();
    const completed = [...current, {
      id: "final-answer",
      role: "assistant" as const,
      content: "done",
      timestamp: 2,
      presentation: { forkPoint: { turnId: "turn-active" } },
    }];
    const result = reconcileDurableQueuedMessages(completed, activeMessageState);

    expect(result.slice(0, -1)).toEqual(completed);
    expect(result.at(-1)).toMatchObject({ id: "source-active", content: "deploy", sendState: "pending" });
  });

  it("does not replace a steering input that matches a different active objective", () => {
    const current = steeringTurn();
    const state = {
      ...activeMessageState,
      active: { ...activeMessageState.active, objective: "also fix ask" },
    };
    const result = reconcileDurableQueuedMessages(current, state);

    expect(result.slice(0, -1)).toEqual(current);
    expect(result.at(-1)).toMatchObject({ id: "source-active", content: "also fix ask" });
  });

  it("keeps a newly promoted queue input separate from an equal transcript input", () => {
    const current = steeringTurn();
    const queued = {
      id: "source-active",
      role: "user" as const,
      content: "deploy",
      timestamp: 3,
      isQueued: true,
      queueItemId: "queue-active",
    };
    const result = reconcileDurableQueuedMessages([...current, queued], activeMessageState);

    expect(result.slice(0, -1)).toEqual(current);
    expect(result.at(-1)).toMatchObject({ id: "source-active", isQueued: false });
  });

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

  it("does not restore pending after runtime activity already acknowledged the active message", () => {
    const acknowledged = {
      id: "source-1",
      role: "user",
      content: "deploy",
      timestamp: 2,
      isQueued: false,
    };
    const reply = {
      id: "assistant-1",
      role: "assistant",
      content: "working",
      timestamp: 3,
    };

    const result = reconcileDurableQueuedMessages([acknowledged, reply], {
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

    expect(result[0]).toEqual(expect.objectContaining({
      id: "source-1",
      isQueued: false,
    }));
    expect(result[1]).toEqual(reply);
    expect(result[0]).not.toHaveProperty("sendState");
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

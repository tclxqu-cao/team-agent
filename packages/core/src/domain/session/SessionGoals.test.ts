import { describe, expect, it } from "vitest";
import {
  EMPTY_SESSION_GOAL_STATE,
  cancelQueuedSessionMessage,
  cancelSessionGoal,
  enqueueSessionGoal,
  enqueueSessionMessage,
  finishActiveSessionGoal,
  projectSessionGoals,
  promoteNextSessionQueueItem,
  queuedSessionMessages,
  readSessionGoalState,
  reorderQueuedSessionGoals,
  reorderQueuedSessionMessages,
  updateQueuedSessionMessage,
  writeSessionGoalState,
} from "./SessionGoals";

function enqueue(state = EMPTY_SESSION_GOAL_STATE, id = "goal-1", now = 1) {
  return enqueueSessionGoal(state, { id, sessionId: "session-1", objective: id, now });
}

describe("SessionGoals", () => {
  it("keeps one active goal and promotes queued goals in order", () => {
    let state = enqueue();
    state = enqueue(state, "goal-2", 2);
    state = enqueue(state, "goal-3", 3);

    expect(state.active?.id).toBe("goal-1");
    expect(state.queued.map((goal) => goal.id)).toEqual(["goal-2", "goal-3"]);

    state = finishActiveSessionGoal(state, "completed", 4);
    expect(state.active?.id).toBe("goal-2");
    expect(state.queued.map((goal) => goal.id)).toEqual(["goal-3"]);
    expect(state.history[0]).toMatchObject({ id: "goal-1", status: "completed" });
  });

  it("reorders queued goals only when the complete id set is supplied", () => {
    let state = enqueue();
    state = enqueue(state, "goal-2", 2);
    state = enqueue(state, "goal-3", 3);
    state = reorderQueuedSessionGoals(state, ["goal-3", "goal-2"]);
    expect(state.queued.map((goal) => [goal.id, goal.position])).toEqual([
      ["goal-3", 0],
      ["goal-2", 1],
    ]);
    expect(() => reorderQueuedSessionGoals(state, ["goal-2"])).toThrow();
  });

  it("persists metadata and promotes the next goal when active is cancelled", () => {
    let state = enqueue();
    state = enqueue(state, "goal-2", 2);
    const metadata = writeSessionGoalState({ keep: true }, state);
    const restored = readSessionGoalState(metadata);
    const cancelled = cancelSessionGoal(restored, "goal-1", 3);

    expect(metadata.keep).toBe(true);
    expect(cancelled.active?.id).toBe("goal-2");
    expect(cancelled.history.at(-1)).toMatchObject({ id: "goal-1", status: "cancelled" });
  });

  it("reads legacy items as goals and writes the discriminator", () => {
    const legacy = enqueue();
    delete legacy.active?.kind;

    const restored = readSessionGoalState({ goalState: legacy });

    expect(restored.active).toMatchObject({ id: "goal-1", kind: "goal" });
  });

  it("keeps messages queued behind an unmanaged run and prioritizes later goals", () => {
    let state = enqueueSessionMessage(EMPTY_SESSION_GOAL_STATE, {
      id: "message-1",
      sessionId: "session-1",
      objective: "follow up",
      sourceMessageId: "chat-1",
      messagePayload: { agentName: "reviewer", images: ["data:image/png;base64,AAAA"] },
      now: 1,
      activate: false,
    });
    state = enqueueSessionGoal(state, {
      id: "goal-1",
      sessionId: "session-1",
      objective: "finish migration",
      now: 2,
    });

    expect(state.active?.id).toBe("goal-1");
    expect(queuedSessionMessages(state)).toEqual([
      expect.objectContaining({ id: "message-1", kind: "message", sourceMessageId: "chat-1" }),
    ]);
    expect(projectSessionGoals(state).active?.id).toBe("goal-1");

    state = finishActiveSessionGoal(state, "completed", 3);
    expect(state.active).toMatchObject({ id: "message-1", kind: "message" });
    expect(state.history).toEqual([expect.objectContaining({ id: "goal-1" })]);
  });

  it("updates and reorders only durable message items", () => {
    let state = enqueueSessionGoal(EMPTY_SESSION_GOAL_STATE, {
      id: "active-goal",
      sessionId: "session-1",
      objective: "active",
      now: 1,
    });
    for (const id of ["message-1", "message-2"]) {
      state = enqueueSessionMessage(state, {
        id,
        sessionId: "session-1",
        objective: id,
        sourceMessageId: `chat-${id}`,
        now: 2,
        activate: false,
      });
    }
    state = updateQueuedSessionMessage(state, "message-1", "edited", { agentIds: ["agent-1"] });
    state = reorderQueuedSessionMessages(state, ["message-2", "message-1"]);

    expect(queuedSessionMessages(state).map((item) => [item.id, item.objective])).toEqual([
      ["message-2", "message-2"],
      ["message-1", "edited"],
    ]);
    expect(projectSessionGoals(state).active?.id).toBe("active-goal");
    expect(() => reorderQueuedSessionGoals(state, [])).not.toThrow();
  });

  it("cancels only waiting message items", () => {
    let state = enqueueSessionMessage(EMPTY_SESSION_GOAL_STATE, {
      id: "active-message",
      sessionId: "session-1",
      objective: "running",
      sourceMessageId: "chat-active",
      now: 1,
      activate: true,
    });
    state = enqueueSessionMessage(state, {
      id: "queued-message",
      sessionId: "session-1",
      objective: "waiting",
      sourceMessageId: "chat-queued",
      now: 2,
      activate: false,
    });

    expect(cancelQueuedSessionMessage(state, "active-message")).toEqual(state);
    expect(cancelQueuedSessionMessage(state, "queued-message").queued).toEqual([]);
  });

  it("promotes a waiting message without retaining completed message history", () => {
    let state = enqueueSessionMessage(EMPTY_SESSION_GOAL_STATE, {
      id: "message-1",
      sessionId: "session-1",
      objective: "queued",
      sourceMessageId: "chat-1",
      now: 1,
      activate: false,
    });
    state = promoteNextSessionQueueItem(state, 2);
    state = finishActiveSessionGoal(state, "completed", 3);

    expect(state).toEqual({ active: null, queued: [], history: [] });
  });
});

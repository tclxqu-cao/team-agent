import { describe, expect, it } from "vitest";
import {
  EMPTY_SESSION_GOAL_STATE,
  cancelSessionGoal,
  enqueueSessionGoal,
  finishActiveSessionGoal,
  readSessionGoalState,
  reorderQueuedSessionGoals,
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
});

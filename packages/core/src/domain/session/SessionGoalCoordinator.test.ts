import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "./SessionStore";
import { SessionGoalCoordinator } from "./SessionGoalCoordinator";

describe("SessionGoalCoordinator", () => {
  it("automatically drains persisted goals in queue order", async () => {
    const store = new InMemorySessionStore();
    await store.create({
      id: "session-1",
      projectId: "",
      title: "goals",
      status: "idle",
      messages: [],
      events: [],
      created: "2026-09-03T00:00:00.000Z",
      updated: "2026-09-03T00:00:00.000Z",
      metadata: {},
    });
    const runs: string[] = [];
    const completions: Array<() => void> = [];
    let nextId = 0;
    const coordinator = new SessionGoalCoordinator(
      store,
      async (_sessionId, objective) => {
        runs.push(objective);
        await new Promise<void>((resolve) => completions.push(resolve));
        return { outcome: "completed" };
      },
      () => undefined,
      () => `goal-${++nextId}`,
      () => nextId,
    );

    await coordinator.enqueue("session-1", "first");
    await coordinator.enqueue("session-1", "second");
    await waitFor(() => expect(runs).toEqual(["first"]));
    expect((await coordinator.get("session-1", false)).queued[0].objective).toBe("second");

    completions.shift()?.();
    await waitFor(() => expect(runs).toEqual(["first", "second"]));
    expect((await coordinator.get("session-1", false)).active?.objective).toBe("second");

    completions.shift()?.();
    await waitFor(async () => expect((await coordinator.get("session-1", false)).active).toBeNull());
    expect((await coordinator.get("session-1", false)).history.map((goal) => goal.objective))
      .toEqual(["first", "second"]);
  });

  it("serializes concurrent goal mutations so enqueues cannot overwrite each other", async () => {
    const store = new InMemorySessionStore();
    await store.create({
      id: "session-concurrent",
      projectId: "",
      title: "goals",
      status: "idle",
      messages: [],
      events: [],
      created: "2026-09-03T00:00:00.000Z",
      updated: "2026-09-03T00:00:00.000Z",
      metadata: {},
    });
    const completions: Array<() => void> = [];
    let nextId = 0;
    const coordinator = new SessionGoalCoordinator(
      store,
      async () => {
        await new Promise<void>((resolve) => completions.push(resolve));
        return { outcome: "completed" };
      },
      () => undefined,
      () => `goal-${++nextId}`,
      () => nextId,
    );

    await Promise.all([
      coordinator.enqueue("session-concurrent", "first"),
      coordinator.enqueue("session-concurrent", "second"),
    ]);

    const state = await coordinator.get("session-concurrent", false);
    expect(state.active?.objective).toBe("first");
    expect(state.queued.map((goal) => goal.objective)).toEqual(["second"]);

    await waitFor(() => expect(completions).toHaveLength(1));
    completions.shift()?.();
    await waitFor(() => expect(completions).toHaveLength(1));
    completions.shift()?.();
    await waitFor(async () => expect((await coordinator.get("session-concurrent", false)).active).toBeNull());
  });
});

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

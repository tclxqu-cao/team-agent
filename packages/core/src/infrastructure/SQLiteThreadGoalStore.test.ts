import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDatabase } from "./SQLiteDatabase.js";
import { SQLiteSessionStore } from "./SQLiteSessionStore.js";
import { SQLiteThreadGoalStore } from "./SQLiteThreadGoalStore.js";
import { createThreadGoal, recordThreadGoalUsage } from "../domain/goal/ThreadGoal.js";

describe("SQLiteThreadGoalStore", () => {
  it("persists, updates and clears one goal per session", async () => {
    const base = mkdtempSync(join(tmpdir(), "customer-agent-thread-goal-store-"));
    const store = new SQLiteThreadGoalStore(base);
    const sessions = new SQLiteSessionStore(base);
    const now = new Date().toISOString();

    try {
      await sessions.create({
        id: "s1", projectId: "", title: "s1", status: "idle", messages: [], events: [],
        created: now, updated: now, metadata: {},
      });
      expect(await store.get("s1")).toBeNull();

      const goal = createThreadGoal("s1", "目标 A", { tokenBudget: 1234, now: "2026-09-15T00:00:00.000Z" });
      await store.set(goal);
      const loaded = await store.get("s1");
      expect(loaded).toEqual(goal);

      await store.set(recordThreadGoalUsage(loaded!, { tokens: 50, seconds: 2 }));
      const updated = await store.get("s1");
      expect(updated!.tokensUsed).toBe(50);
      expect(updated!.turnCount).toBe(1);
      expect(updated!.createdAt).toBe("2026-09-15T00:00:00.000Z");

      expect(await store.clear("s1")).toBe(true);
      expect(await store.clear("s1")).toBe(false);
      expect(await store.get("s1")).toBeNull();
    } finally {
      getDatabase(base).close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("lists active goals only and cascades deletion with the session", async () => {
    const base = mkdtempSync(join(tmpdir(), "customer-agent-thread-goal-store-"));
    const store = new SQLiteThreadGoalStore(base);
    const sessions = new SQLiteSessionStore(base);
    const now = new Date().toISOString();

    try {
      for (const id of ["s-active", "s-paused", "s-deleted"]) {
        await sessions.create({
          id, projectId: "", title: id, status: "idle", messages: [], events: [],
          created: now, updated: now, metadata: {},
        });
      }
      await store.set(createThreadGoal("s-active", "a", { now }));
      await store.set({ ...createThreadGoal("s-paused", "b", { now }), status: "paused" });
      await store.set(createThreadGoal("s-deleted", "c", { now }));

      expect((await store.listActive()).map((goal) => goal.sessionId).sort()).toEqual(["s-active", "s-deleted"]);

      await sessions.delete("s-deleted");
      expect(await store.get("s-deleted")).toBeNull();
      expect((await store.listActive()).map((goal) => goal.sessionId)).toEqual(["s-active"]);
    } finally {
      getDatabase(base).close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

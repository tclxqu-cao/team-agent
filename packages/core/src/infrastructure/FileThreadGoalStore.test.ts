import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileThreadGoalStore } from "./FileThreadGoalStore.js";
import { createThreadGoal } from "../domain/goal/ThreadGoal.js";

describe("FileThreadGoalStore", () => {
  it("persists goals across store instances and lists active only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "customer-agent-file-goal-store-"));
    try {
      const store = new FileThreadGoalStore(dir);
      expect(await store.get("s1")).toBeNull();

      await store.set(createThreadGoal("s1", "目标 A", { now: "2026-09-15T00:00:00.000Z" }));
      await store.set({ ...createThreadGoal("s2", "目标 B", { now: "2026-09-15T00:00:00.000Z" }), status: "blocked" });

      const reopened = new FileThreadGoalStore(dir);
      expect((await reopened.get("s1"))?.objective).toBe("目标 A");
      expect((await reopened.listActive()).map((goal) => goal.sessionId)).toEqual(["s1"]);

      expect(await reopened.clear("s1")).toBe(true);
      expect(await reopened.get("s1")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores corrupt files instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "customer-agent-file-goal-store-"));
    try {
      const store = new FileThreadGoalStore(dir);
      writeFileSync(join(dir, "thread-goals.json"), "{broken json", "utf8");
      expect(await store.get("s1")).toBeNull();
      expect(await store.listActive()).toEqual([]);
      await store.set(createThreadGoal("s1", "重建", { now: "2026-09-15T00:00:00.000Z" }));
      expect((await store.get("s1"))?.objective).toBe("重建");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

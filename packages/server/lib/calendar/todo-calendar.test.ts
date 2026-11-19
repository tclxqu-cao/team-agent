import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteDatabase, SQLiteTodoUnitOfWork, TodoApplicationService } from "@agent/core";
import { readCodexSource } from "./codex-source";
import { readClaudeSource } from "./claude-source";
import { readTodoCalendar } from "./todo-reminder-source";
describe("calendar Todo boundaries", () => {
  it("ignores session task/rollout stores and projects only owned independent dated Todos", async () => {
    const root = mkdtempSync(join(tmpdir(), "todo-calendar-")), now = Date.parse("2026-11-17T01:00:00Z"), range = { nowMs: now, fromMs: now - 3600000, toMs: now + 86400000 };
    let db: SQLiteDatabase | undefined;
    try {
      mkdirSync(join(root, "tasks", "session"), { recursive: true }); writeFileSync(join(root, "tasks", "session", "1.json"), JSON.stringify({ subject: "不是个人待办", status: "pending" }));
      expect((await readClaudeSource(range, root)).groups).toEqual([]); expect((await readCodexSource(range, root)).groups).toEqual([]);
      db = new SQLiteDatabase(root); const app = new TodoApplicationService(new SQLiteTodoUnitOfWork(db.db), () => now);
      app.execute({ type: "create", title: "自己的日期事项", dueAt: now + 60000 }, { ownerId: "a", requestId: "create" });
      app.execute({ type: "create", title: "另一个用户", dueAt: now + 60000 }, { ownerId: "b", requestId: "create" });
      expect(readTodoCalendar(range, root, "a").map(e => [e.kind, e.title])).toEqual([["reminder", "自己的日期事项"]]);
      const [reminder] = readTodoCalendar(range, root, "a");
      expect(reminder).toMatchObject({ dueAt: now + 60000, detail: "待办日期 · 到点提醒", source: "customer-agent" });
      expect(reminder?.executionAgentType).toBeUndefined();
      const scheduledAt = now + 120000;
      const { task } = app.execute({
        type: "create", title: "提前完成的定时待办", kind: "scheduled",
        executionSchedule: {
          trigger: { kind: "once", at: scheduledAt },
          target: { agentType: "codex", cwd: root, permissionMode: "default" },
        },
      }, { ownerId: "a", requestId: "scheduled" });
      const readScheduled = () => readTodoCalendar(range, root, "a").filter(entry => entry.taskId === task.id);
      expect(readScheduled()).toMatchObject([{ source: "customer-agent", executionAgentType: "codex", at: scheduledAt }]);
      const reassigned = app.execute({
        type: "schedule", taskId: task.id, expectedVersion: task.version, enabled: true,
        target: { agentType: "zcode", cwd: root, permissionMode: "default" },
      }, { ownerId: "a", requestId: "reassign" });
      expect(readScheduled()).toMatchObject([{ source: "customer-agent", executionAgentType: "zcode", at: scheduledAt }]);
      app.execute({ type: "complete", taskId: task.id, expectedVersion: reassigned.task.version }, { ownerId: "a", requestId: "complete" });
      expect(readTodoCalendar(range, root, "a").filter(entry => entry.taskId === task.id))
        .toMatchObject([{ at: scheduledAt, state: "completed", title: task.title, executionAgentType: "zcode" }]);
      expect(readTodoCalendar(range, root)).toEqual([]);
    } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

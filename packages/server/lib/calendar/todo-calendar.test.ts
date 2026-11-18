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
      expect(readTodoCalendar(range, root, "a")[0]).toMatchObject({ dueAt: now + 60000, detail: "待办日期 · 到点提醒" });
      expect(readTodoCalendar(range, root)).toEqual([]);
    } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteDatabase } from "../../infrastructure/SQLiteDatabase";
import { SQLiteTodoUnitOfWork } from "../../infrastructure/SQLiteTodoUnitOfWork";
import { TodoApplicationService } from "./TodoApplicationService";
import { TodoExecutionService, TodoScheduler } from "./TodoScheduler";
import { PersistentNotificationService } from "../notification/NotificationService";
import type { TodoDetail } from "../../domain/todo/entities";

describe("persistent personal Todos", () => {
  let root: string, db: SQLiteDatabase, uow: SQLiteTodoUnitOfWork, service: TodoApplicationService, scheduler: TodoScheduler, execution: TodoExecutionService;
  let now: number;
  const owner = "owner-a";
  const context = (requestId: string) => ({ ownerId: owner, requestId, sourceSessionRef: "source-chat" });
  const create = (kind: "normal" | "scheduled" = "normal") => service.execute({ type: "create", title: "核对报告", kind }, context("create"));
  const once = (at: number) => ({ kind: "once" as const, at });
  const schedule = (d: TodoDetail, trigger = once(now + 60000)) => service.execute({ type: "schedule", taskId: d.task.id, expectedVersion: d.task.version, trigger, enabled: true, target: { agentType: "claude-code", cwd: root, permissionMode: "default" } }, context("schedule"));
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "todo-domain-")); now = Date.parse("2026-11-17T01:00:00Z"); db = new SQLiteDatabase(root); uow = new SQLiteTodoUnitOfWork(db.db); service = new TodoApplicationService(uow, () => now); scheduler = new TodoScheduler(uow); execution = new TodoExecutionService(uow, () => now); });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  it("retries the same command after a lost response and survives database restart", () => {
    const d = create(); expect(create()).toEqual(d);
    expect(() => service.execute({ type: "create", title: "不同正文" }, context("create"))).toThrow(/requestId/);
    db.close(); db = new SQLiteDatabase(root); uow = new SQLiteTodoUnitOfWork(db.db); service = new TodoApplicationService(uow, () => now);
    expect(service.get(d.task.id, owner).task.title).toBe("核对报告");
    expect(service.list({}, owner).items).toHaveLength(1);
  });
  it("isolates owners, enforces versions, and keeps Todos without a source session", () => {
    const d = create();
    expect(() => service.get(d.task.id, "owner-b")).toThrow("不存在");
    expect(service.list({}, "owner-b").items).toEqual([]);
    expect(() => service.execute({ type: "complete", taskId: d.task.id, expectedVersion: 0 }, context("conflict"))).toThrow("刷新");
    expect(service.get(d.task.id, owner).task.version).toBe(1);
    expect(db.db.prepare("PRAGMA foreign_key_list(todo_tasks)").all()).toEqual([]);
  });
  it("rolls back a rejected reminder and never turns dates or links into execution", () => {
    const d = create();
    expect(() => service.execute({ type: "remind", taskId: d.task.id, expectedVersion: 1, trigger: { kind: "cron", expression: "bad" } }, context("invalid"))).toThrow("五字段");
    expect(service.get(d.task.id, owner).reminders).toEqual([]);
    expect(service.get(d.task.id, owner).task.version).toBe(1);
    const linked = service.execute({ type: "linkSchedule", taskId: d.task.id, expectedVersion: 1, scheduleRef: "codex:external" }, context("link"));
    service.execute({ type: "remind", taskId: d.task.id, expectedVersion: linked.task.version, trigger: once(now + 60000) }, context("remind"));
    expect(() => schedule(service.get(d.task.id, owner))).toThrow("只有定时任务");
    now += 60000; expect(scheduler.tick(now)).toMatchObject({ reminded: 1, queued: 0 });
    expect(scheduler.tick(now)).toMatchObject({ reminded: 0, queued: 0 });
    expect(execution.pending()).toHaveLength(0);
  });
  it("creates the reminder atomically and defaults a future date to a notification only", () => {
    expect(() => service.execute({ type: "create", title: "invalid", reminder: { kind: "cron", expression: "invalid" } }, context("invalid-create"))).toThrow();
    expect(service.list({}, owner).items).toHaveLength(0);
    expect(uow.run(tx => tx.todo_reminder_schedules.list(owner))).toHaveLength(0);
    const d = service.execute({ type: "create", title: "dated", dueAt: now + 60000 }, context("create"));
    expect(d.reminders[0]).toMatchObject({ origin: "due", enabled: true, nextFireAt: now + 60000 });
    now += 60000; expect(scheduler.tick(now)).toMatchObject({ reminded: 1, queued: 0 });
    expect(execution.pending()).toEqual([]);
  });
  it("moves the default date reminder but preserves a user's custom reminder", () => {
    let d = service.execute({ type: "create", title: "dated", dueAt: now + 60000 }, context("create"));
    d = service.execute({ type: "update", taskId: d.task.id, expectedVersion: d.task.version, patch: { dueAt: now + 120000 } }, context("postpone"));
    expect(d.reminders[0].nextFireAt).toBe(now + 120000);
    d = service.execute({ type: "remind", taskId: d.task.id, expectedVersion: d.task.version, trigger: once(now + 30000) }, context("custom"));
    d = service.execute({ type: "update", taskId: d.task.id, expectedVersion: d.task.version, patch: { dueAt: now + 180000 } }, context("later"));
    expect(d.reminders[0].nextFireAt).toBe(now + 30000);
  });
  it("stops reminders on complete/cancel and reopen does not resurrect them", () => {
    let d = create(); d = service.execute({ type: "remind", taskId: d.task.id, expectedVersion: 1, trigger: once(now + 60000) }, context("remind"));
    d = service.execute({ type: "complete", taskId: d.task.id, expectedVersion: d.task.version }, context("complete"));
    d = service.execute({ type: "reopen", taskId: d.task.id, expectedVersion: d.task.version }, context("reopen"));
    now += 60000; expect(scheduler.tick(now).reminded).toBe(0); expect(d.reminders[0].enabled).toBe(false);
  });
  it("settles scheduled business success only after a successful authoritative runtime result", () => {
    const d = schedule(create("scheduled")); now += 60000;
    expect(scheduler.tick(now).queued).toBe(1); expect(scheduler.tick(now).queued).toBe(0);
    const e = execution.pending()[0]; execution.bind(owner, e.id, "dedicated-session", "run-1");
    execution.report(owner, e.id, "run-1", `${e.id}:progress`, "progress", "started");
    const result = execution.report(owner, e.id, "run-1", `${e.id}:result`, "succeeded", "报告已核对，输出文件存在");
    expect(execution.report(owner, e.id, "run-1", `${e.id}:result`, "succeeded", "报告已核对，输出文件存在")).toEqual(result);
    expect(service.get(d.task.id, owner).task.status).toBe("in_progress");
    execution.settle(owner, e.id, "completed");
    expect(service.get(d.task.id, owner).task.status).toBe("completed");
    expect(service.get(d.task.id, owner).executions[0].status).toBe("succeeded");
  });
  it("runtime failure overrides a candidate business success, missing report needs review", () => {
    const d = schedule(create("scheduled")); now += 60000; scheduler.tick(now);
    const e = execution.pending()[0]; execution.bind(owner, e.id, "dedicated", "run");
    execution.report(owner, e.id, "run", "r", "succeeded", "candidate"); execution.settle(owner, e.id, "failed");
    expect(service.get(d.task.id, owner).executions[0].status).toBe("failed");
    expect(service.get(d.task.id, owner).task.status).toBe("failed");
  });
  it("user completion wins against late results and keeps schedules disabled", () => {
    const d = schedule(create("scheduled")); now += 60000; scheduler.tick(now); const e = execution.pending()[0]; execution.bind(owner, e.id, "dedicated", "run");
    execution.report(owner, e.id, "run", "r", "succeeded", "candidate");
    const current = service.get(d.task.id, owner); service.execute({ type: "cancel", taskId: d.task.id, expectedVersion: current.task.version }, context("cancel"));
    execution.settle(owner, e.id, "completed");
    expect(service.get(d.task.id, owner).task.status).toBe("cancelled"); expect(service.get(d.task.id, owner).schedule?.enabled).toBe(false);
  });
  it("keeps progress-only completions for review and idempotent binds do not churn task versions", () => {
    const d = schedule(create("scheduled")); now += 60000; scheduler.tick(now); const e = execution.pending()[0];
    execution.bind(owner, e.id, "dedicated", "run"); const version = service.get(d.task.id, owner).task.version;
    execution.bind(owner, e.id, "dedicated", "run"); expect(service.get(d.task.id, owner).task.version).toBe(version);
    execution.report(owner, e.id, "run", "progress", "progress", "started"); execution.settle(owner, e.id, "completed");
    expect(service.get(d.task.id, owner).executions[0].status).toBe("needs_review"); expect(service.get(d.task.id, owner).task.status).toBe("failed");
  });
  it("skips overlapping recurring executions and a paused schedule stays paused on settlement", () => {
    let d = create("scheduled");
    d = service.execute({ type: "schedule", taskId: d.task.id, expectedVersion: d.task.version, trigger: { kind: "cron", expression: "* * * * *" }, enabled: true, target: { agentType: "claude-code", cwd: root, permissionMode: "default" } }, context("schedule"));
    now += 60000; scheduler.tick(now); const e = execution.pending()[0]; execution.bind(owner, e.id, "dedicated", "run");
    now += 60000; expect(scheduler.tick(now).skipped).toBe(1);
    d = service.get(d.task.id, owner); service.execute({ type: "schedule", taskId: d.task.id, expectedVersion: d.task.version, enabled: false }, context("pause"));
    execution.report(owner, e.id, "run", "result", "succeeded", "done"); execution.settle(owner, e.id, "completed");
    expect(service.get(d.task.id, owner).task.status).toBe("pending"); expect(service.get(d.task.id, owner).schedule?.enabled).toBe(false);
  });
  it("catches up only the latest missed reminder and invalidates it after postponement", () => {
    let d = create(); d = service.execute({ type: "remind", taskId: d.task.id, expectedVersion: d.task.version, trigger: { kind: "cron", expression: "* * * * *" }, timeZone: "UTC" }, context("remind"));
    now += 10 * 60000; expect(scheduler.tick(now).reminded).toBe(1);
    expect(uow.run(tx => tx.todo_reminder_occurrences.list(owner)[0].scheduledAt)).toBe(now);
    d = service.get(d.task.id, owner); service.execute({ type: "remind", taskId: d.task.id, expectedVersion: d.task.version, trigger: once(now + 60000) }, context("postpone"));
    expect(new PersistentNotificationService(uow, () => now).claim(owner, "desktop").items).toHaveLength(0);
  });
  it("records missed executions without replaying the business", () => {
    const d = schedule(create("scheduled")); now += 10 * 60000; expect(scheduler.tick(now)).toMatchObject({ missed: 1, queued: 0 });
    expect(execution.pending()).toHaveLength(0); expect(service.get(d.task.id, owner).executions[0].status).toBe("missed");
  });
  it("separates read state from device display and reclaims a delivery after lease expiry", () => {
    const notices = new PersistentNotificationService(uow, () => now);
    const intent = { ownerId: owner, sourceEventId: "run:done", kind: "completion" as const, title: "完成", body: "报告", createdAt: now };
    const n = notices.ingest(intent); expect(notices.ingest(intent).id).toBe(n.id);
    expect(notices.claim("owner-b", "desktop").items).toEqual([]);
    expect(notices.claim(owner, "desktop").items).toHaveLength(1);
    expect(notices.claim(owner, "desktop").items).toHaveLength(0);
    now += 31000; expect(notices.claim(owner, "desktop").items).toHaveLength(1);
    notices.ack(owner, n.id, "desktop"); expect(notices.list(owner)[0].readAt).toBeUndefined();
    expect(notices.claim(owner, "desktop").items).toHaveLength(0);
    expect(notices.claim(owner, "another-device").items).toHaveLength(1);
  });
});

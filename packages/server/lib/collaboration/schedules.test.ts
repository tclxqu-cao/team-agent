import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronTasks } from "@agent/core";
import { groupFixture } from "../../../core/src/domain/collaboration/__tests__/fixtures.js";
import { cancelCustomerSchedule, cancelGroupSchedules } from "./schedules";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function localTasks() {
  const dir = mkdtempSync(join(tmpdir(), "group-schedules-")); directories.push(dir);
  const tasks = new CronTasks(dir);
  const input = { cron: "1h", prompt: "not executed", recurring: true, enabled: true };
  const bound = tasks.create(input), unrelated = tasks.create(input);
  return { tasks, bound, unrelated };
}

describe("group schedule lifecycle", () => {
  it("cancels only explicit provider/task/session bindings", async () => {
    const group = groupFixture();
    group.scheduledTasks = [{ agentType: "customer-agent", taskId: "local" }, { agentType: "deepseek-harness", taskId: "native", sessionId: "owner" }];
    const ports = { customer: vi.fn(async () => {}), harness: vi.fn(async () => {}) };
    await cancelGroupSchedules(group, ports);
    expect(ports.customer.mock.calls).toEqual([["local"]]);
    expect(ports.harness.mock.calls).toEqual([["owner", "native"]]);
  });
  it("does not contact a scheduler for a group without associated tasks", async () => {
    const ports = { customer: vi.fn(async () => {}), harness: vi.fn(async () => {}) };
    await cancelGroupSchedules(groupFixture(), ports);
    expect(ports.customer).not.toHaveBeenCalled(); expect(ports.harness).not.toHaveBeenCalled();
  });
  it("reports cancellation failure instead of allowing deletion to succeed", async () => {
    const group = groupFixture(); group.scheduledTasks = [{ agentType: "deepseek-harness", taskId: "native", sessionId: "owner" }];
    await expect(cancelGroupSchedules(group, { customer: vi.fn(), harness: vi.fn().mockRejectedValue(new Error("host offline")) })).rejects.toMatchObject({ code: "SCHEDULE_CANCEL_FAILED", message: expect.stringContaining("host offline") });
  });
  it("removes an exact local task, preserves unrelated tasks and permits retries", () => {
    const { tasks, bound, unrelated } = localTasks();
    cancelCustomerSchedule(tasks, bound.id);
    cancelCustomerSchedule(tasks, bound.id);
    expect(tasks.list()).toEqual([unrelated]);
  });
  it("does not use a prefix to cancel an unrelated local task", () => {
    const { tasks, bound, unrelated } = localTasks();
    expect(() => cancelCustomerSchedule(tasks, bound.id.slice(0, 4))).toThrow("完整 ID");
    expect(tasks.list()).toEqual([bound, unrelated]);
  });
  it("fails visibly when local scheduler state cannot be verified", () => {
    const { tasks, bound } = localTasks();
    writeFileSync(tasks.getFilePath(), "invalid json");
    expect(() => cancelCustomerSchedule(tasks, bound.id)).toThrow();
  });
});

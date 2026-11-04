import { existsSync, readFileSync } from "node:fs";
import { CollaborationError, CronTasks, type CollaborationGroup } from "@agent/core";
import { DeepSeekHarnessScheduleClient } from "@agent/native-runtime";
import { getServerBaseDir } from "../server-data-dir";

export interface GroupScheduleCancellation {
  customer(taskId: string): Promise<void>;
  harness(sessionId: string, taskId: string): Promise<void>;
}

/** CronTasks.delete accepts prefixes; group cleanup must use exact identities only. */
export function cancelCustomerSchedule(tasks: CronTasks, taskId: string): void {
  const read = () => {
    if (!existsSync(tasks.getFilePath())) return [];
    const value = JSON.parse(readFileSync(tasks.getFilePath(), "utf8"));
    if (!Array.isArray(value.tasks)) throw new Error("定时任务存储无效");
    return tasks.list();
  };
  const current = read();
  if (!current.some(task => task.id === taskId) && current.some(task => task.id.startsWith(taskId)))
    throw new Error("取消群聊定时任务需要完整 ID");
  if (current.some(task => task.id === taskId)) tasks.delete(taskId);
  if (read().some(task => task.id === taskId)) throw new Error("关联定时任务仍存在");
}

export async function cancelGroupSchedules(group: CollaborationGroup, cancellation?: GroupScheduleCancellation): Promise<void> {
  if (!group.scheduledTasks?.length) return;
  const harness = cancellation ? undefined : new DeepSeekHarnessScheduleClient();
  const ports = cancellation ?? {
    customer: async (taskId: string) => cancelCustomerSchedule(new CronTasks(getServerBaseDir()), taskId),
    harness: (sessionId: string, taskId: string) => harness!.cancel(sessionId, taskId),
  };
  try {
    for (const task of group.scheduledTasks) {
      if (task.agentType === "customer-agent") await ports.customer(task.taskId);
      else await ports.harness(task.sessionId, task.taskId);
    }
  } catch (error) {
    throw new CollaborationError(`取消群聊定时任务失败，请重试删除：${error instanceof Error ? error.message : String(error)}`, "SCHEDULE_CANCEL_FAILED");
  } finally { await harness?.dispose(); }
}

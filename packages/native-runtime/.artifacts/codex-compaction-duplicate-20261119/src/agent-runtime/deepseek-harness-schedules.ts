import { DeepSeekHarnessClient, harnessRecord, type HarnessConnection } from "./deepseek-harness-client.js";
import { discoverHarnessEndpoint } from "./deepseek-harness-endpoint.js";
import { RuntimeSessionError } from "./types.js";

/** Cancels reminders through their live owner; never starts a replacement Host. */
export class DeepSeekHarnessScheduleClient {
  constructor(private readonly connection: HarnessConnection = new DeepSeekHarnessClient({
    discoverEndpoint: async () => {
      const endpoint = await discoverHarnessEndpoint();
      if (!endpoint) throw new RuntimeSessionError("DeepSeek Harness 未运行，无法取消关联定时任务", "RUNTIME_UNAVAILABLE");
      return endpoint;
    },
  })) {}

  async cancel(sessionId: string, taskId: string): Promise<void> {
    const result = harnessRecord(await this.connection.request("schedule/delete", { request: { sessionId, id: taskId } }));
    if (result.id !== taskId || !(result.deleted === true || result.deleted === false && result.code === "schedule_not_found"))
      throw new RuntimeSessionError("DeepSeek Harness 定时任务取消回执无效", "NATIVE_PROTOCOL_ERROR");
    // A wrong session binding must not turn "not found" into false success.
    const tasks = await this.connection.request("schedule/catalog", {});
    if (!Array.isArray(tasks) || tasks.some(task => typeof harnessRecord(task).id !== "string"))
      throw new RuntimeSessionError("DeepSeek Harness 定时任务回读无效", "NATIVE_PROTOCOL_ERROR");
    if (tasks.some(task => harnessRecord(task).id === taskId))
      throw new RuntimeSessionError("关联定时任务仍存在，取消尚未完成", "NATIVE_PROTOCOL_ERROR");
  }

  dispose(): Promise<void> { return this.connection.dispose(); }
}

import { CronTasks, type CronTask } from "@agent/core";
import { CronScheduler } from "@agent/native-runtime";
import { getServerBaseDir } from "./server-data-dir";

class SharedCronService {
  readonly tasks = new CronTasks(getServerBaseDir());
  readonly scheduler = new CronScheduler(this.tasks, (task) => { void this.fire(task).catch((error) => console.error("Scheduled Customer Agent run failed", error)); }, () => {});
  constructor() { this.scheduler.start(); }
  private async fire(task: CronTask) {
    const { agentHost } = await import("../app/api/agent-host");
    const { getCustomerGoalCoordinator } = await import("./customer-goal-service");
    let sessionId = task.sessionId;
    if (!sessionId || !await agentHost.getSessionStore().get(sessionId)) {
      const session = await agentHost.createSession(task.label || "定时任务");
      sessionId = session.id;
      this.tasks.update(task.id, { sessionId });
    }
    await getCustomerGoalCoordinator().enqueue(sessionId, task.prompt);
  }
  call(method: string, args: unknown[]) {
    const id = String(args[0] || "");
    switch (method) {
      case "cronList": return this.tasks.list();
      case "cronCreate": {
        if (typeof args[0] !== "string" || typeof args[1] !== "string" || !args[1].trim()) throw new Error("cron and prompt required");
        const options = args[2] && typeof args[2] === "object" ? args[2] as Partial<CronTask> : {};
        return this.tasks.create({ cron: args[0], prompt: args[1], recurring: options.recurring !== false, enabled: true, durable: true, ...(typeof options.sessionId === "string" ? { sessionId: options.sessionId } : {}), ...(typeof options.label === "string" ? { label: options.label } : {}) });
      }
      case "cronPause": return this.tasks.pause(id);
      case "cronResume": return this.tasks.resume(id);
      case "cronDelete": return this.tasks.delete(id);
      case "cronDeleteAll": this.tasks.deleteAll(); return { ok: true };
      default: throw new Error("Unsupported schedule operation");
    }
  }
}
const state = globalThis as typeof globalThis & { __sharedCronService?: SharedCronService };
export function sharedCron() { return state.__sharedCronService ??= new SharedCronService(); }

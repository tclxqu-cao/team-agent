import { randomUUID } from "node:crypto";
import { SQLiteMessagingRepository, MessagingService } from "@agent/core";
import { ServerMessagingRuntime } from "./runtime";
import { collectWecom } from "./wecom/collector";
import { getServerBaseDir } from "../server-data-dir";

export class MessagingWorker {
  private busy = false;
  private owner = randomUUID();
  private timer: ReturnType<typeof setInterval>;
  private heartbeat: ReturnType<typeof setInterval>;
  constructor(readonly repository: SQLiteMessagingRepository, readonly service: MessagingService) {
    this.timer = setInterval(() => { void this.tick(); }, 5000); this.timer.unref();
    this.heartbeat = setInterval(() => { if (this.busy) repository.lease(this.owner); }, 15_000); this.heartbeat.unref();
    void this.tick();
  }
  async tick(): Promise<void> {
    if (!this.repository.settings().enabled && !this.repository.active().length
      && !this.repository.deliveries().some(item => item.status === "pending" || item.status === "sending")) {
      if (this.repository.worker().state !== "paused") this.repository.status({ state: "paused", updatedAt: new Date().toISOString() });
      return;
    }
    if (this.busy || !this.repository.lease(this.owner)) return;
    this.busy = true;
    try {
      if (this.repository.settings().enabled) {
        try { await collectWecom(this.repository); }
        catch (error) { this.repository.status({ state: "error", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "企微采集失败" }); }
        await this.service.routePending();
      } else this.repository.status({ state: "paused", updatedAt: new Date().toISOString() });
      await this.service.executePending();
      await this.service.deliver();
    } catch (error) {
      this.repository.status({ state: "error", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "消息处理失败" });
    } finally { this.busy = false; this.repository.release(this.owner); }
  }
  close(): void { clearInterval(this.timer); clearInterval(this.heartbeat); this.repository.release(this.owner); }
}
const global = globalThis as typeof globalThis & { __messaging?: { repository: SQLiteMessagingRepository; service: MessagingService; worker: MessagingWorker; runtime: ServerMessagingRuntime } };
export function messagingService() {
  if (!global.__messaging) {
    const repository = new SQLiteMessagingRepository(getServerBaseDir());
    const runtime = new ServerMessagingRuntime();
    const service = new MessagingService(repository, runtime);
    global.__messaging = { repository, runtime, service, worker: new MessagingWorker(repository, service) };
  }
  return global.__messaging;
}

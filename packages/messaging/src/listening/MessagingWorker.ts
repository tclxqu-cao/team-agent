import { randomUUID } from "node:crypto";
import type { MessagingWorkerStore } from "../application/ports.js";
import type { MessagingService } from "../application/MessagingService.js";
import type { MessageIntake } from "../intake/MessageIntake.js";

type Stage = "collect" | "route" | "execute" | "deliver";
const labels: Record<Stage, string> = { collect: "消息监听", route: "消息识别与路由", execute: "会话执行", deliver: "消息发送" };

/** Independent stages share the existing durable lease, preserving one owner across hosts. */
export class MessagingWorker {
  private readonly owner = randomUUID();
  private readonly busy = new Set<Stage>();
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private ownsLease = false;
  private scheduling = 0;
  private closed = false;
  constructor(private readonly repository: MessagingWorkerStore, private readonly service: Pick<MessagingService, "routePending" | "executePending" | "deliver">,
    private readonly intake: Pick<MessageIntake, "collect">, options: { autoStart?: boolean; intervalMs?: number } = {}) {
    if (options.autoStart !== false) {
      this.timer = setInterval(() => { void this.tick(); }, options.intervalMs ?? 5000); this.timer.unref();
      void this.tick();
    }
    this.heartbeat = setInterval(() => { if (this.ownsLease && this.busy.size) this.repository.lease(this.owner); }, 15_000);
    this.heartbeat.unref();
  }
  private releaseIfIdle(): void {
    if (this.busy.size || this.scheduling) return;
    if (this.ownsLease) this.repository.release(this.owner);
    this.ownsLease = false;
    if (this.closed) clearInterval(this.heartbeat);
  }
  private status(stage: Stage, state: "running" | "idle" | "error", error?: string): void {
    const previous = this.repository.worker();
    const updatedAt = new Date().toISOString();
    this.repository.status({ ...previous, updatedAt, ...(error ? { state: "error", error: labels[stage] + "：" + error } : {}),
      stages: { ...previous.stages, [stage]: { state, updatedAt, ...(error ? { error } : {}) } } });
  }
  private async run(stage: Stage, action: () => Promise<void>): Promise<void> {
    if (this.busy.has(stage)) return;
    this.busy.add(stage);
    try { this.status(stage, "running"); await action(); this.status(stage, "idle"); }
    catch (error) { this.status(stage, "error", error instanceof Error ? error.message : "处理失败"); }
    finally { this.busy.delete(stage); this.releaseIfIdle(); }
  }
  async tick(): Promise<void> {
    if (this.closed) return;
    const enabled = this.repository.settings().enabled;
    if (!enabled && !this.busy.size && !this.repository.active().length
      && !this.repository.deliveries().some(item => item.status === "pending" || item.status === "sending")) {
      if (this.repository.worker().state !== "paused") this.repository.status({ state: "paused", updatedAt: new Date().toISOString() });
      return;
    }
    if (!this.repository.lease(this.owner)) return;
    this.ownsLease = true;
    const actions: Array<[Stage, () => Promise<void>]> = [
      ...(enabled ? [["collect", () => this.intake.collect()], ["route", () => this.service.routePending()]] as Array<[Stage, () => Promise<void>]> : []),
      ["execute", () => this.service.executePending()], ["deliver", () => this.service.deliver()],
    ];
    this.scheduling++;
    const tasks = actions.map(([stage, action]) => this.run(stage, action));
    this.scheduling--;
    await Promise.allSettled(tasks);
    this.releaseIfIdle();
  }
  close(): void { this.closed = true; clearInterval(this.timer); this.releaseIfIdle(); }
}

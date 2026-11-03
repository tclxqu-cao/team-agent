import type { ChannelMessage, DeliveryRecord, MessageEvent, MessageRecord, RoutingDecision } from "../../domain/messaging/types.js";
import { bindingKey, ruleRoute, validateRoutingDecision } from "../../domain/messaging/routing.js";
import type { MessagingRepository, MessagingRuntime } from "./ports.js";

/** Coordinates messages; execution ownership remains with the runtime. */
export class MessagingService {
  constructor(readonly repository: MessagingRepository, private readonly runtime: MessagingRuntime) {}
  receive(source: ChannelMessage): MessageRecord { return this.repository.insert(source); }
  private note(record: MessageRecord, stage: string, text: string): void {
    record.timeline.push({ at: new Date().toISOString(), stage, text });
  }
  async resolve(id: string, decision: RoutingDecision): Promise<MessageRecord> {
    const record = this.repository.get(id);
    if (!record || record.routing.status !== "review" || record.execution.status !== "pending") throw new Error("仅待确认且尚未执行的消息可以选择目标");
    const candidates = await this.runtime.candidates();
    record.routing.candidates = candidates;
    const validated = validateRoutingDecision(decision, candidates);
    record.routing.initialDecision = record.routing.decision;
    record.routing.confirmedByUser = true;
    record.routing.decision = validated;
    record.execution.projectName = candidates.find(item => item.projectId === decision.projectId)?.projectName;
    record.routing.status = "routed";
    this.note(record, "routed", "用户确认执行目标：" + decision.reason);
    this.repository.save(record);
    return record;
  }
  async routePending(): Promise<void> {
    for (const record of this.repository.pending().slice(0, 1)) {
      if (!this.repository.settings().enabled) break;
      try {
        if (!record.source.text.trim()) {
          record.routing.status = "review";
          record.routing.decision = { action: "review", reason: "未取得可执行的正文，请补充任务内容或到原会话查看附件" };
          this.note(record, "review", record.routing.decision.reason);
          this.repository.commit(record, this.eventDeliveries(record, "routing-review:" + record.id, "waiting", record.routing.decision.reason));
          continue;
        }
        const candidates = await this.runtime.candidates();
        record.routing.context = this.repository.context(record.source);
        record.routing.status = "routing"; record.routing.candidates = candidates;
        this.repository.save(record);
        const decision = validateRoutingDecision(record.routing.mode === "rules"
          ? ruleRoute(record.source, this.repository.settings())
          : await this.runtime.route(record.source, candidates, record.routing.context), candidates);
        record.routing.decision = decision;
        record.routing.status = decision.action === "dispatch" ? "routed" : decision.action === "ignore" ? "ignored" : "review";
        record.execution.projectName = candidates.find(item => item.projectId === decision.projectId)?.projectName;
        this.note(record, "routed", decision.reason);
        this.repository.commit(record, decision.action === "review" ? this.eventDeliveries(record, "routing-review:" + record.id, "waiting", decision.reason) : []);
      } catch (error) {
        record.routing.status = "review";
        record.routing.decision = { action: "review", reason: error instanceof Error ? error.message : "路由判断失败" };
        this.note(record, "review", record.routing.decision.reason);
        this.repository.commit(record, this.eventDeliveries(record, "routing-review:" + record.id, "waiting", record.routing.decision.reason));
      }
    }
  }
  async executePending(): Promise<void> {
    for (const record of this.repository.active()) {
      if (record.execution.status === "pending" && !this.repository.settings().enabled) continue;
      try {
        if (record.execution.status === "pending") {
          const key = bindingKey(record);
          // One observed run at a time per binding preserves results before the next dispatch.
          if (this.repository.active().some(other => other.id !== record.id && bindingKey(other) === key && other.execution.status !== "pending")) continue;
          let sessionId = this.repository.binding(key);
          if (!sessionId) {
            sessionId = await this.runtime.createSession(record);
            this.repository.bind(key, sessionId);
          }
          record.execution.sessionId = sessionId;
          record.execution.status = "dispatching";
          this.note(record, "dispatching", "已保存派发意图");
          this.repository.save(record);
          const receipt = await this.runtime.dispatch(record);
          record.execution.queueItemId = receipt.queueItemId;
          record.execution.runId = receipt.runId;
          record.execution.status = receipt.runId ? "running" : "queued";
          record.execution.startedAt = new Date().toISOString();
          this.note(record, "accepted", receipt.runId ? "Agent 已接收并开始执行" : "Agent 已接收，等待执行");
          this.repository.save(record);
        }
        const observation = await this.runtime.observe(record);
        record.execution.status = observation.status;
        record.execution.runId = observation.runId ?? record.execution.runId;
        record.execution.queueItemId = observation.queueItemId ?? record.execution.queueItemId;
        record.execution.error = observation.error;
        const deliveries: DeliveryRecord[] = [];
        for (const event of observation.events) {
          if (event.sequence <= record.execution.lastSequence) continue;
          record.execution.lastSequence = event.sequence;
          if (event.kind === "completed") record.execution.result = event.text;
          if (event.kind === "failed") record.execution.error = event.text;
          this.note(record, event.kind, event.text.slice(0, 2000));
          deliveries.push(...this.eventDeliveries(record, event.id, event.kind, event.text));
        }
        record.execution.lastSequence = Math.max(record.execution.lastSequence, observation.sequence ?? 0);
        if (["completed", "failed", "aborted"].includes(observation.status)) record.execution.finishedAt ??= new Date().toISOString();
        this.repository.commit(record, deliveries);
      } catch (error) {
        const knownNotDispatched = record.execution.status === "pending";
        record.execution.status = knownNotDispatched ? "failed" : "unknown";
        record.execution.error = error instanceof Error ? error.message : "执行状态尚未确认";
        this.note(record, "execution", record.execution.error);
        if (knownNotDispatched) {
          record.execution.finishedAt = new Date().toISOString();
          this.repository.commit(record, this.eventDeliveries(record, "admission-failed:" + record.id, "failed", record.execution.error));
        } else this.repository.save(record);
      }
    }
  }
  private eventDeliveries(record: MessageRecord, eventId: string, event: MessageEvent, text: string): DeliveryRecord[] {
    const now = new Date().toISOString();
    const heading = event === "completed" ? "任务完成" : event === "failed" ? "执行失败" : "需要你的确认";
    const body = heading + "\n" + text;
    const targets: DeliveryRecord["target"][] = [
      { kind: "origin", address: record.source.conversationId, label: record.source.conversationName || record.source.conversationId },
      ...this.repository.settings().subscriptions.filter(item => item.enabled && item.events.includes(event))
        .map(item => ({ kind: item.kind, address: item.address, label: item.label || item.kind })),
    ];
    return targets.map(target => ({
      id: crypto.randomUUID(), messageId: record.id, eventId, event, target, text: body,
      status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: now, updatedAt: now,
    }));
  }
  async deliver(): Promise<void> {
    for (const delivery of this.repository.deliveries()) {
      if (delivery.status === "sending") {
        delivery.status = "unknown"; delivery.error = "发送过程中服务重启，送达结果需要核对"; this.repository.saveDelivery(delivery); continue;
      }
      if (delivery.status !== "pending" || delivery.nextAttemptAt > Date.now()) continue;
      const record = this.repository.get(delivery.messageId);
      if (!record) continue;
      delivery.status = "sending"; delivery.attempts++; this.repository.saveDelivery(delivery);
      try { Object.assign(delivery, await this.runtime.send(delivery, record.source)); }
      catch (error) { delivery.status = "unknown"; delivery.error = error instanceof Error ? error.message : "无法确认送达"; }
      this.repository.saveDelivery(delivery);
    }
  }
  retryDelivery(id: string): void {
    const item = this.repository.delivery(id);
    if (!item || !["failed", "blocked"].includes(item.status)) throw new Error("仅明确失败或未发送的回传可以重试；未知送达请先核对");
    if (item.attempts >= 5) throw new Error("已达到五次投递上限，请核对接收通道");
    item.status = "pending"; item.error = undefined; this.repository.saveDelivery(item);
  }
}

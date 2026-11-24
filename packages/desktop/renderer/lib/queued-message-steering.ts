import type { AgentApi, SessionGoalState } from "../../../shared/src/contracts/agent-api";
import type { DurableQueuedMessageLike } from "./queued-message-order";

export function canSteerQueuedMessage(
  message: Pick<DurableQueuedMessageLike, "isQueued" | "queueItemId">,
  durableQueue: boolean,
): boolean {
  return message.isQueued === true && (!durableQueue || Boolean(message.queueItemId));
}

/** Durable input must be consumed by queue ID, including during initial admission. */
export async function steerQueuedMessage(
  message: DurableQueuedMessageLike,
  sessionId: string,
  durableQueue: boolean,
  api: Pick<AgentApi, "steer" | "steerSessionMessage">,
): Promise<SessionGoalState | undefined> {
  if (!canSteerQueuedMessage(message, durableQueue)) {
    throw new Error("排队消息正在保存，请稍后再引导");
  }
  if (message.queueItemId) {
    return api.steerSessionMessage(sessionId, message.queueItemId);
  }
  if (message.images?.length) throw new Error("当前服务不支持带图片的插入消息，请保留在队列中等待执行");
  if (!await api.steer(message.content, sessionId, message.agentName)) {
    throw new Error("当前运行不支持插队消息");
  }
}

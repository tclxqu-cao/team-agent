import type { CollaborationCommand } from "@agent/core/domain/collaboration/types";
import { AGENT_LABELS } from "../../lib/agent-catalog";

export async function collaborationRequest<T>(
  command: CollaborationCommand,
  options?: { signal?: AbortSignal },
): Promise<T> {
  if (!window.agentApi?.collaboration)
    throw new Error("当前服务不支持协作群，请连接更新后的服务");
  return (await window.agentApi.collaboration(command, options)) as T;
}

export const AGENT_NAMES = AGENT_LABELS;
export const DISCUSSION_STATUS = {
  idle: "未开始",
  running: "协作中",
  waiting: "等待你",
  stopping: "正在停止",
  stopped: "已停止",
  completed: "已完成",
  interrupted: "已中断",
} as const;

import type { CollaborationCommand } from "@agent/core/domain/collaboration/types";

export async function collaborationRequest<T>(
  command: CollaborationCommand,
): Promise<T> {
  if (!window.agentApi?.collaboration)
    throw new Error("当前服务不支持协作群，请连接更新后的服务");
  return (await window.agentApi.collaboration(command)) as T;
}

export const AGENT_NAMES = {
  "customer-agent": "Customer Agent",
  codex: "Codex",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  "deepseek-harness": "DeepSeek Harness",
  qoder: "Qoder",
  zcode: "ZCode",
  workbuddy: "WorkBuddy",
} as const;
export const DISCUSSION_STATUS = {
  idle: "未开始",
  running: "协作中",
  waiting: "等待你",
  stopping: "正在停止",
  stopped: "已停止",
  completed: "已完成",
  interrupted: "已中断",
} as const;

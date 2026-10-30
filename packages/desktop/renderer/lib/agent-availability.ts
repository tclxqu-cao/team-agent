import type { AgentType, RuntimeHealth } from "../global";
import { AGENT_LABELS } from "./agent-catalog";

/** Unavailable choices stay visible so a click can explain why switching is blocked. */
export function agentUnavailableMessage(agentType: AgentType, health: readonly RuntimeHealth[]): string | undefined {
  const runtime = health.find(entry => entry.agentType === agentType);
  if (runtime?.available || (agentType === "customer-agent" && !runtime)) return undefined;
  const label = AGENT_LABELS[agentType];
  if (!runtime) return `正在检查远程 ${label}，请稍后重试`;
  return /not installed|not found|ENOENT|未安装|找不到/i.test(runtime.error ?? "")
    ? `远程未安装 ${label}` : `远程 ${label} 暂不可用`;
}

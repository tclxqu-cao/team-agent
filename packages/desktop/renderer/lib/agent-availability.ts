import type { AgentType, RuntimeHealth } from "../../../shared/src/contracts/agent-api";
import { AGENT_TYPES } from "../../../core/src/domain/agent/agent-type";
import { AGENT_LABELS } from "./agent-catalog";

export function availableAgentTypes(health: readonly RuntimeHealth[]): AgentType[] {
  const available = new Set(health.filter(entry => entry.available).map(entry => entry.agentType));
  return AGENT_TYPES.filter(type => available.has(type) || (type === "customer-agent" && !health.some(entry => entry.agentType === type)));
}

/** Direct links and existing sessions can still report why their runtime is unavailable. */
export function agentUnavailableMessage(agentType: AgentType, health: readonly RuntimeHealth[]): string | undefined {
  const runtime = health.find(entry => entry.agentType === agentType);
  if (runtime?.available || (agentType === "customer-agent" && !runtime)) return undefined;
  const label = AGENT_LABELS[agentType];
  if (!runtime) return `正在检查远程 ${label}，请稍后重试`;
  return /not installed|not found|ENOENT|未安装|找不到/i.test(runtime.error ?? "")
    ? `远程未安装 ${label}` : `远程 ${label} 暂不可用`;
}

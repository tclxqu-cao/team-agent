import type { ChannelMessage, MessagingSettings, RoutingCandidate, RoutingDecision } from "./types.js";

export function validateRoutingDecision(value: RoutingDecision, candidates: RoutingCandidate[]): RoutingDecision {
  if (!value || !["dispatch", "review", "ignore"].includes(value.action) || typeof value.reason !== "string" || !value.reason.trim())
    throw new Error("路由判断缺少有效动作或原因");
  if (value.action !== "dispatch") return { action: value.action, reason: value.reason.slice(0, 4000), model: value.model };
  const project = candidates.find(item => item.projectId === value.projectId);
  if (!project || !value.agentType || !project.agents.includes(value.agentType))
    throw new Error("模型选择了候选列表以外的项目或 Agent");
  return { action: "dispatch", projectId: project.projectId, agentType: value.agentType, reason: value.reason.slice(0, 4000), model: value.model };
}

export function ruleRoute(source: ChannelMessage, settings: MessagingSettings): RoutingDecision {
  const rules = settings.rules.filter(rule => rule.conversationId === source.conversationId);
  if (rules.length !== 1) return { action: "review", reason: rules.length ? "该群有多条规则，请保留一条" : "没有匹配的群规则，请选择项目和 Agent" };
  return { action: "dispatch", projectId: rules[0].projectId, agentType: rules[0].agentType, reason: "按群固定规则匹配" };
}

export function bindingKey(record: { source: ChannelMessage; routing: { decision?: RoutingDecision } }): string {
  return JSON.stringify([record.source.connectionId, record.source.conversationId, record.routing.decision?.projectId, record.routing.decision?.agentType]);
}

export const AGENT_TYPES = [
  "customer-agent", "codex", "claude-code", "opencode", "deepseek-harness",
  "qoder", "zcode", "workbuddy",
] as const;

export type AgentType = typeof AGENT_TYPES[number];
export type NativeAgentType = Exclude<AgentType, "customer-agent">;

export const NATIVE_AGENT_TYPES: readonly NativeAgentType[] = AGENT_TYPES.filter(
  (type): type is NativeAgentType => type !== "customer-agent",
);

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && AGENT_TYPES.some((type) => type === value);
}

export function isNativeAgentType(value: unknown): value is NativeAgentType {
  return isAgentType(value) && value !== "customer-agent";
}

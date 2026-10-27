import type { AgentType } from "../../../core/src/domain/agent/agent-type";

export const AGENT_LABELS: Record<AgentType, string> = {
  "customer-agent": "Customer Agent", codex: "Codex", "claude-code": "Claude Code",
  opencode: "OpenCode", "deepseek-harness": "DeepSeek Harness",
  qoder: "Qoder", zcode: "ZCode", workbuddy: "WorkBuddy",
};

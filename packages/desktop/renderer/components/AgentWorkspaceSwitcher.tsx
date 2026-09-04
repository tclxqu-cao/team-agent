import type { AgentType, RuntimeHealth } from "../global";
import AgentBrandIcon from "./AgentBrandIcon";

const AGENTS: Array<{ agentType: AgentType; label: string }> = [
  { agentType: "customer-agent", label: "Customer Agent" },
  { agentType: "codex", label: "Codex" },
  { agentType: "claude-code", label: "Claude Code" },
  { agentType: "opencode", label: "OpenCode" },
];

interface AgentWorkspaceSwitcherProps {
  value: AgentType;
  health: RuntimeHealth[];
  onChange(agentType: AgentType): void;
}

export default function AgentWorkspaceSwitcher({ value, health, onChange }: AgentWorkspaceSwitcherProps) {
  return (
    <div className="agent-workspace-switcher" role="tablist" aria-label="切换 Agent">
      {AGENTS.map((agent) => {
        const runtime = health.find((entry) => entry.agentType === agent.agentType);
        const unavailable = runtime?.available === false;
        return (
          <button
            key={agent.agentType}
            type="button"
            role="tab"
            aria-selected={value === agent.agentType}
            aria-label={agent.label}
            title={unavailable ? `${agent.label} 不可用：${runtime?.error ?? "未检测到运行时"}` : agent.label}
            className={value === agent.agentType ? "is-active" : ""}
            onClick={() => onChange(agent.agentType)}
          >
            <AgentBrandIcon agentType={agent.agentType} size={22} />
            <i className={unavailable ? "is-unavailable" : ""} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

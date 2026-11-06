import type { AgentType } from "../global";
import { AGENT_LABELS } from "../lib/agent-catalog";
import AgentBrandIcon from "./AgentBrandIcon";

export type ParallelAgentStatus = "idle" | "running" | "needs-input" | "completed" | "failed";
export interface ParallelAgentTab { id: string; agentType: AgentType; status: ParallelAgentStatus }
const STATUS_LABELS: Record<ParallelAgentStatus, string> = {
  idle: "待发送", running: "执行中", "needs-input": "待确认", completed: "已完成", failed: "失败",
};

export default function ParallelAgentTabs({ members, selectedId, onSelect }: {
  members: ParallelAgentTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return <div className="parallel-agent-tabs" role="tablist" aria-label="Agent 会话" onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
    const current = tabs.indexOf(event.target as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[index]?.focus();
    const member = members[index];
    if (member) onSelect(member.id);
  }}>
    {members.map(member => {
      const label = `${AGENT_LABELS[member.agentType]} · ${STATUS_LABELS[member.status]}`;
      return <button key={member.id} type="button" role="tab" className="parallel-agent-tab"
        aria-label={label} title={label} aria-selected={member.id === selectedId}
        onClick={() => onSelect(member.id)}>
        <AgentBrandIcon agentType={member.agentType} size={18} />
        <span className={`parallel-agent-status is-${member.status}`} aria-hidden="true" />
      </button>;
    })}
  </div>;
}

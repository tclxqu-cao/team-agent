import { X } from "lucide-react";
import type { AgentType, RuntimeHealth } from "../global";
import { AGENT_LABELS } from "../lib/agent-catalog";
import AgentBrandIcon from "./AgentBrandIcon";

interface Props {
  value: AgentType;
  health: RuntimeHealth[];
  onClose(): void;
}

export default function AgentWorkspaceHeader({ value, health, onClose }: Props) {
  const runtime = health.find((entry) => entry.agentType === value);
  const state = runtime?.available === false ? "unavailable" : runtime?.available || value === "customer-agent" ? "ready" : "checking";
  const label = state === "ready" ? "本机已连接" : state === "checking" ? "正在检查运行时" : "运行时暂不可用";
  return <header className="sidebar-agent-header">
    <span className="sidebar-agent-header-icon"><AgentBrandIcon agentType={value} size={23} /></span>
    <div className="sidebar-agent-header-identity">
      <span className="sidebar-agent-header-name" title={AGENT_LABELS[value]}>{AGENT_LABELS[value]}</span>
      <span className={`sidebar-agent-header-status is-${state}`} title={runtime?.error}><i aria-hidden="true" />{label}</span>
    </div>
    <button type="button" className="ui-icon-button sidebar-agent-header-close" onClick={onClose} aria-label="收起会话列表" title="收起会话列表"><X size={18} aria-hidden="true" /></button>
  </header>;
}

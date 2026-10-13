import { useEffect, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import type { AgentType, RuntimeHealth } from "../global";
import AgentBrandIcon from "./AgentBrandIcon";

const AGENTS: Array<{ agentType: AgentType; label: string }> = [
  { agentType: "customer-agent", label: "Customer Agent" },
  { agentType: "codex", label: "Codex" },
  { agentType: "claude-code", label: "Claude Code" },
  { agentType: "opencode", label: "OpenCode" },
  { agentType: "deepseek-harness", label: "DeepSeek Harness" },
];

interface AgentWorkspaceSwitcherProps {
  value: AgentType;
  health: RuntimeHealth[];
  onChange(agentType: AgentType): void;
}

export default function AgentWorkspaceSwitcher({ value, health, onChange }: AgentWorkspaceSwitcherProps) {
  const track = useRef<HTMLDivElement>(null);
  const [showPrevious, setShowPrevious] = useState(false);
  useEffect(() => {
    const element = track.current;
    const reveal = () => {
      const selected = element?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      if (!element || !selected) return;
      const left = selected.offsetLeft;
      if (left < element.scrollLeft) element.scrollTo({ left, behavior: "smooth" });
      else if (left + selected.offsetWidth > element.scrollLeft + element.clientWidth) element.scrollTo({ left: left + selected.offsetWidth - element.clientWidth, behavior: "smooth" });
    };
    reveal();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    if (element) observer?.observe(element);
    return () => observer?.disconnect();
  }, [value]);
  return (
    <div className="agent-workspace-switcher">
      <div ref={track} className="agent-workspace-track" role="tablist" aria-label="切换 Agent" onScroll={(event) => setShowPrevious(event.currentTarget.scrollLeft > 1)}>
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
      <button type="button" className="agent-workspace-more" aria-label={showPrevious ? "前面的 Agent" : "更多 Agent"} title={`${showPrevious ? "前面的 Agent" : "更多 Agent"} · 手机可左右滑动`} onClick={() => {
        const element = track.current;
        if (!element) return;
        const end = element.scrollWidth - element.clientWidth;
        element.scrollTo({ left: showPrevious ? 0 : end, behavior: "smooth" });
      }}>{showPrevious ? <ChevronsLeft size={20} strokeWidth={1.8} aria-hidden="true" /> : <ChevronsRight size={20} strokeWidth={1.8} aria-hidden="true" />}</button>
    </div>
  );
}

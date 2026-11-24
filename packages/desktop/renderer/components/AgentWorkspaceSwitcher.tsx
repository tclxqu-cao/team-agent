import { useEffect, useRef, useState } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import type { AgentType, RuntimeHealth } from "../../../shared/src/contracts/agent-api";
import AgentBrandIcon from "./AgentBrandIcon";
import { AGENT_LABELS } from "../lib/agent-catalog";
import { availableAgentTypes } from "../lib/agent-availability";

interface AgentWorkspaceSwitcherProps {
  value: AgentType;
  health: RuntimeHealth[];
  onChange(agentType: AgentType): void;
  vertical?: boolean;
  onPreview?(agentType: AgentType, label: string, anchor: DOMRect): void;
}

export default function AgentWorkspaceSwitcher({ value, health, onChange, vertical = false, onPreview }: AgentWorkspaceSwitcherProps) {
  const track = useRef<HTMLDivElement>(null);
  const [showPrevious, setShowPrevious] = useState(false);
  useEffect(() => {
    if (vertical) return;
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
  }, [value, vertical]);
  return (
    <div className={`agent-workspace-switcher${vertical ? " is-vertical" : ""}`}>
      <div ref={track} className="agent-workspace-track" role="tablist" aria-label="切换 Agent" aria-orientation={vertical ? "vertical" : "horizontal"} onScroll={(event) => setShowPrevious(event.currentTarget.scrollLeft > 1)}>
      {availableAgentTypes(health).map(agentType => {
        const label = AGENT_LABELS[agentType];
        return (
          <button
            key={agentType}
            type="button"
            role="tab"
            aria-selected={value === agentType}
            aria-label={label}
            title={label}
            className={value === agentType ? "is-active" : undefined}
            onPointerEnter={event => onPreview?.(agentType, label, event.currentTarget.getBoundingClientRect())}
            onFocus={event => onPreview?.(agentType, label, event.currentTarget.getBoundingClientRect())}
            onClick={() => onChange(agentType)}
          >
            <AgentBrandIcon agentType={agentType} size={22} />
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

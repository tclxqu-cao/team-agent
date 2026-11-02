import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AgentType, RuntimeHealth } from "../global";
import { AGENT_TYPES } from "../../../core/src/domain/agent/agent-type";
import { AGENT_LABELS } from "../lib/agent-catalog";
import { agentUnavailableMessage } from "../lib/agent-availability";
import { useComposerPickerHeight } from "../lib/use-composer-picker-height";
import AgentBrandIcon from "./AgentBrandIcon";

export interface AgentPickerItem {
  agentType: AgentType;
  label: string;
  unavailableMessage?: string;
}

/** Full agent list plus the reason each unavailable runtime is blocked. */
export function agentPickerItems(health: readonly RuntimeHealth[] = []): AgentPickerItem[] {
  return AGENT_TYPES.map((agentType) => {
    const unavailableMessage = agentUnavailableMessage(agentType, health);
    return unavailableMessage
      ? { agentType, label: AGENT_LABELS[agentType], unavailableMessage }
      : { agentType, label: AGENT_LABELS[agentType] };
  });
}

interface ComposerAgentPickerProps {
  value: AgentType;
  health?: RuntimeHealth[];
  onChange: (agentType: AgentType) => void;
  /** Test-only hook so the menu can be asserted without a click; production stays collapsed. */
  defaultOpen?: boolean;
}

export default function ComposerAgentPicker({ value, health = [], onChange, defaultOpen = false }: ComposerAgentPickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const wrapRef = useRef<HTMLDivElement>(null);
  const maxHeight = useComposerPickerHeight(open, wrapRef);
  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]:not([aria-disabled="true"])'));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(current + step + items.length) % items.length]?.focus();
  };

  const items = agentPickerItems(health);
  return (
    <div className="composer-agent-picker" ref={wrapRef} data-composer-agent-picker={value}>
      <button
        type="button"
        className="composer-agent-picker-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Agent：${AGENT_LABELS[value]}，点击切换`}
        title={`Agent：${AGENT_LABELS[value]}（点击切换）`}
        onClick={() => setOpen((next) => !next)}
      >
        <AgentBrandIcon agentType={value} size={16} />
        <span className="composer-picker-label">{AGENT_LABELS[value]}</span>
        <ChevronDown className="composer-picker-chevron" size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div className="composer-agent-picker-menu" role="menu" aria-label="选择 Agent" style={{ maxHeight }} onKeyDown={handleMenuKeyDown}>
          {items.map((item) => {
            const blocked = item.unavailableMessage !== undefined;
            const selected = item.agentType === value;
            return (
              <button
                key={item.agentType}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-disabled={blocked || undefined}
                data-agent-type={item.agentType}
                title={blocked ? item.unavailableMessage : item.label}
                className={[selected ? "is-active" : "", blocked ? "is-unavailable" : ""].filter(Boolean).join(" ") || undefined}
                onClick={() => {
                  if (blocked) return;
                  onChange(item.agentType);
                  setOpen(false);
                }}
              >
                <span className="composer-picker-check" aria-hidden="true">{selected ? "✓" : ""}</span>
                <AgentBrandIcon agentType={item.agentType} size={18} />
                <span className="composer-picker-copy">
                  <strong>{item.label}</strong>
                  {blocked && <small>{item.unavailableMessage}</small>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

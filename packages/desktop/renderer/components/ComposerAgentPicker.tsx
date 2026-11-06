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
  values?: readonly AgentType[];
  onValuesChange?: (agentTypes: AgentType[]) => void;
  allowedAgentTypes?: readonly AgentType[];
  purpose?: "participants" | "recipients";
  /** Test-only hook so the menu can be asserted without a click; production stays collapsed. */
  defaultOpen?: boolean;
}

export default function ComposerAgentPicker({ value, health = [], onChange, values, onValuesChange, allowedAgentTypes, purpose = "participants", defaultOpen = false }: ComposerAgentPickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState<AgentType[]>(() => [...(values ?? [value])]);
  const multiple = values !== undefined && onValuesChange !== undefined;
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
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not([aria-disabled="true"])'));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(current + step + items.length) % items.length]?.focus();
  };

  const items = agentPickerItems(health).filter(item => !allowedAgentTypes || allowedAgentTypes.includes(item.agentType));
  const committed = values ?? [value];
  const label = !multiple || committed.length === 1 ? AGENT_LABELS[committed[0] ?? value]
    : purpose === "participants" ? `Agent · ${committed.length}`
    : committed.length === items.length ? `全部（${committed.length}）` : `已选 ${committed.length}/${items.length}`;
  const menuLabel = purpose === "recipients" ? "这条消息发给谁" : "选择 Agent";
  return (
    <div className="composer-agent-picker" ref={wrapRef} data-composer-agent-picker={value}>
      <button
        type="button"
        className="composer-agent-picker-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={multiple ? `${purpose === "recipients" ? "发送对象" : "参与 Agent"}：${label}` : `Agent：${AGENT_LABELS[value]}，点击切换`}
        title={multiple ? `${menuLabel}：${committed.map(type => AGENT_LABELS[type]).join("、")}` : `Agent：${AGENT_LABELS[value]}（点击切换）`}
        onClick={() => { if (!open) setDraft([...committed]); setOpen((next) => !next); }}
      >
        <AgentBrandIcon agentType={committed[0] ?? value} size={16} />
        <span className="composer-picker-label">{label}</span>
        <ChevronDown className="composer-picker-chevron" size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div className="composer-agent-picker-menu" role="menu" aria-label={menuLabel} style={{ maxHeight }} onKeyDown={handleMenuKeyDown}>
          {multiple && <div className="composer-agent-picker-heading">{menuLabel}</div>}
          {multiple && purpose === "recipients" && <button type="button" role="menuitemcheckbox"
            aria-checked={draft.length === items.length}
            onClick={() => setDraft(draft.length === items.length ? [] : items.map(item => item.agentType))}>
            <span className="composer-picker-check" aria-hidden="true">{draft.length === items.length ? "✓" : ""}</span>
            <span className="composer-picker-copy"><strong>全部 Agent</strong></span>
          </button>}
          {items.map((item) => {
            const blocked = purpose !== "recipients" && item.unavailableMessage !== undefined;
            const selected = multiple ? draft.includes(item.agentType) : item.agentType === value;
            return (
              <button
                key={item.agentType}
                type="button"
                role={multiple ? "menuitemcheckbox" : "menuitemradio"}
                aria-checked={selected}
                aria-disabled={blocked || undefined}
                data-agent-type={item.agentType}
                title={blocked ? item.unavailableMessage : item.label}
                className={[selected ? "is-active" : "", blocked ? "is-unavailable" : ""].filter(Boolean).join(" ") || undefined}
                onClick={() => {
                  if (blocked) return;
                  if (multiple) {
                    setDraft(previous => selected ? previous.filter(type => type !== item.agentType) : [...previous, item.agentType]);
                    return;
                  }
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
          {multiple && <button type="button" className="composer-agent-picker-done" disabled={!draft.length}
            onClick={() => { onValuesChange?.(draft); setOpen(false); }}>完成 · 已选 {draft.length} 个</button>}
        </div>
      )}
    </div>
  );
}

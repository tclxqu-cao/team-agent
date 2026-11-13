import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, ChevronDown, LoaderCircle } from "lucide-react";
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
  /**
   * Single-agent sessions only: picking another native engine switches this
   * logical conversation onto it (context handoff) instead of changing the
   * composer agent. Multi-agent composers must not pass this.
   */
  onSwitchEngine?: (agentType: AgentType) => void;
  /** True while a switch request is in flight. */
  switching?: boolean;
  values?: readonly AgentType[];
  onValuesChange?: (agentTypes: AgentType[]) => void;
  allowedAgentTypes?: readonly AgentType[];
  purpose?: "participants" | "recipients";
  placement?: "composer" | "header";
  /** Test-only hook so the menu can be asserted without a click; production stays collapsed. */
  defaultOpen?: boolean;
}

export default function ComposerAgentPicker({ value, health = [], onChange, onSwitchEngine, switching = false, values, onValuesChange, allowedAgentTypes, purpose = "participants", placement = "composer", defaultOpen = false }: ComposerAgentPickerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const multiple = values !== undefined && onValuesChange !== undefined;
  const wrapRef = useRef<HTMLDivElement>(null);
  const inHeader = placement === "header";
  const maxHeight = useComposerPickerHeight(open, wrapRef, inHeader ? "below" : "above");
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

  const switchable = !multiple && onSwitchEngine !== undefined;
  const items = agentPickerItems(health)
    .filter(item => !allowedAgentTypes || allowedAgentTypes.includes(item.agentType))
    .filter(item => !switchable || item.agentType !== "customer-agent");
  const committed = values ?? [value];
  const label = !multiple || committed.length === 1 ? AGENT_LABELS[committed[0] ?? value]
    : purpose === "participants" ? `Agent · ${committed.length}`
    : committed.length === items.length ? `全部（${committed.length}）` : `已选 ${committed.length}/${items.length}`;
  const menuLabel = purpose === "recipients" ? "这条消息发给谁" : "选择 Agent";
  return (
    <div className={`composer-agent-picker${inHeader ? " composer-agent-picker--header" : ""}`} ref={wrapRef} data-composer-agent-picker={value}>
      <button
        type="button"
        className={inHeader ? "ui-icon-button chat-header-action composer-agent-picker-button composer-agent-picker-button--icon" : "composer-agent-picker-button"}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={switching}
        aria-label={multiple ? `${purpose === "recipients" ? "发送对象" : "参与 Agent"}：${label}` : `Agent：${AGENT_LABELS[value]}，${switchable ? "点击切换引擎" : "点击切换"}`}
        title={multiple ? `${menuLabel}：${committed.map(type => AGENT_LABELS[type]).join("、")}` : `Agent：${AGENT_LABELS[value]}（${switchable ? "点击切换引擎，保留上下文" : "点击切换"}）`}
        onClick={() => setOpen((next) => !next)}
      >
        {inHeader
          ? switching ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={17} aria-hidden="true" />
          : <><AgentBrandIcon agentType={committed[0] ?? value} size={16} />
            <span className="composer-picker-label">{label}</span>
            <ChevronDown className="composer-picker-chevron" size={14} strokeWidth={2} aria-hidden="true" /></>}
      </button>
      {open && (
        <div className="composer-agent-picker-menu" role="menu" aria-label={menuLabel} style={{ maxHeight }} onKeyDown={handleMenuKeyDown}>
          {multiple && <div className="composer-agent-picker-heading">
            <span>{menuLabel}</span><small>点名称单选，勾选框多选 · 立即生效</small>
          </div>}
          {switchable && <div className="composer-agent-picker-heading">
            <span>切换引擎</span><small>{switching ? "正在交接上下文…" : "保留当前会话上下文，工具调用只作历史记录"}</small>
          </div>}
          {multiple && purpose === "recipients" && <button type="button" role="menuitem"
            onClick={() => onValuesChange(items.map(item => item.agentType))}>
            <span className="composer-picker-check" aria-hidden="true">{committed.length === items.length ? "✓" : ""}</span>
            <span className="composer-picker-copy"><strong>全部 Agent</strong></span>
          </button>}
          {items.map((item) => {
            const blocked = purpose !== "recipients" && item.unavailableMessage !== undefined;
            const selected = multiple ? committed.includes(item.agentType) : item.agentType === value;
            const className = [selected ? "is-active" : "", blocked ? "is-unavailable" : ""].filter(Boolean).join(" ") || undefined;
            const copy = <><AgentBrandIcon agentType={item.agentType} size={18} />
              <span className="composer-picker-copy">
                <strong>{item.label}</strong>
                {blocked && <small>{item.unavailableMessage}</small>}
              </span></>;
            if (multiple) {
              const lastSelected = selected && committed.length === 1;
              return <div key={item.agentType} role="none" className={`composer-agent-option${className ? ` ${className}` : ""}`}>
                <button type="button" role="menuitem" className="composer-agent-option-main"
                  data-agent-type={item.agentType} aria-label={`仅使用 ${item.label}`} aria-disabled={blocked || undefined}
                  title={blocked ? item.unavailableMessage : `仅使用 ${item.label}`}
                  onClick={() => {
                    if (blocked) return;
                    onValuesChange([item.agentType]);
                    setOpen(false);
                  }}>{copy}</button>
                <button type="button" role="menuitemcheckbox" className="composer-agent-option-toggle"
                  aria-label={`${selected ? "取消选择" : "添加"} ${item.label}`} aria-checked={selected}
                  aria-disabled={blocked || lastSelected || undefined}
                  title={blocked ? item.unavailableMessage : lastSelected ? "至少保留一个 Agent" : `${selected ? "取消选择" : "添加"} ${item.label}`}
                  onClick={() => {
                    if (blocked || lastSelected) return;
                    onValuesChange(selected ? committed.filter(type => type !== item.agentType) : [...committed, item.agentType]);
                  }}><span className="composer-agent-checkbox" aria-hidden="true">{selected ? "✓" : ""}</span></button>
              </div>;
            }
            return (
              <button
                key={item.agentType}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-disabled={blocked || undefined}
                data-agent-type={item.agentType}
                title={blocked ? item.unavailableMessage : item.label}
                className={className}
                onClick={() => {
                  if (blocked) return;
                  if (switchable && item.agentType !== value) {
                    onSwitchEngine!(item.agentType);
                  } else {
                    onChange(item.agentType);
                  }
                  setOpen(false);
                }}
              >
                <span className="composer-picker-check" aria-hidden="true">{selected ? "✓" : ""}</span>
                {copy}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

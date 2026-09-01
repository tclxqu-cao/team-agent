import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentType, RuntimeHealth } from "../global";

const RUNTIMES: Array<{ agentType: AgentType; mark: string; label: string }> = [
  { agentType: "customer-agent", mark: "CA", label: "Customer Agent" },
  { agentType: "codex", mark: "CX", label: "Codex" },
  { agentType: "claude-code", mark: "CC", label: "Claude Code" },
];

const MENU_WIDTH = 220;
const MENU_HEIGHT = 138;

interface RuntimeSessionMenuProps {
  health: RuntimeHealth[];
  disabled?: boolean;
  onSelect(agentType: AgentType): void | Promise<void>;
}

export default function RuntimeSessionMenu({ health, disabled, onSelect }: RuntimeSessionMenuProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) {
            const left = Math.min(
              Math.max(rect.right - MENU_WIDTH, 8),
              Math.max(8, window.innerWidth - MENU_WIDTH - 8),
            );
            let top = rect.bottom + 4;
            if (top + MENU_HEIGHT > window.innerHeight - 8) top = Math.max(8, rect.top - MENU_HEIGHT - 4);
            setAnchor({ top, left });
          }
          setOpen((value) => !value);
        }}
        disabled={disabled}
        title="新建会话"
        aria-label="新建会话"
        aria-expanded={open}
        className="sidebar-row-action sidebar-row-action--accent ui-icon-button ui-icon-button--small"
        style={{ fontSize: 16, lineHeight: 1 }}
      >+</button>
      {open && anchor && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: "fixed",
            top: anchor.top,
            left: anchor.left,
            zIndex: 10020,
            width: MENU_WIDTH,
            padding: 5,
            border: "1px solid var(--border-default)",
            borderRadius: 8,
            background: "var(--bg-surface)",
            boxShadow: "var(--shadow-md)",
          }}
        >
          {RUNTIMES.map((runtime) => {
            const state = health.find((entry) => entry.agentType === runtime.agentType);
            const available = state?.available ?? runtime.agentType === "customer-agent";
            return (
              <button
                type="button"
                role="menuitem"
                key={runtime.agentType}
                disabled={!available}
                title={available ? `使用 ${runtime.label}` : state?.error || `${runtime.label} 不可用`}
                onClick={() => {
                  setOpen(false);
                  void onSelect(runtime.agentType);
                }}
                style={{
                  width: "100%",
                  minHeight: 36,
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "6px 8px",
                  border: 0,
                  borderRadius: 5,
                  background: "transparent",
                  color: available ? "var(--text-secondary)" : "var(--text-muted)",
                  cursor: available ? "pointer" : "not-allowed",
                  opacity: available ? 1 : 0.5,
                  textAlign: "left",
                }}
              >
                <span style={{
                  width: 25,
                  height: 19,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 4,
                  background: "var(--bg-deep)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-muted)",
                  fontSize: 9,
                  fontWeight: 700,
                }}>{runtime.mark}</span>
                <span style={{ flex: 1, fontSize: 12 }}>{runtime.label}</span>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: available ? "var(--success)" : "var(--danger)" }} />
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

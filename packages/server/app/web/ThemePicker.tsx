"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { WEB_THEMES, type WebThemeId } from "./themes";

interface Props {
  username: string;
  themeId: WebThemeId;
  onThemeChange: (id: WebThemeId) => void;
  accent: string;
  accentText: string;
}

export default function ThemePicker({ username, themeId, onThemeChange, accent, accentText }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const initial = (username.trim()[0] ?? "?").toUpperCase();

  const syncPopoverPos = () => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = 168;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
    setPopoverPos({ top: rect.bottom + 6, left });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    syncPopoverPos();
    window.addEventListener("resize", syncPopoverPos);
    window.addEventListener("scroll", syncPopoverPos, true);
    return () => {
      window.removeEventListener("resize", syncPopoverPos);
      window.removeEventListener("scroll", syncPopoverPos, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("pointerdown", onPointerDown, true);
    }, 0);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen((value) => !value);
  };

  return (
    <div ref={rootRef} className="theme-picker">
      <button
        ref={buttonRef}
        type="button"
        className="theme-avatar"
        aria-label={`换肤（${username}）`}
        title={username}
        aria-expanded={open}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={toggle}
        style={{
          width: 28,
          height: 28,
          borderRadius: 99,
          border: `1px solid ${accent}`,
          background: accent,
          color: accentText,
          fontSize: 12,
          fontWeight: 700,
          padding: 0,
          cursor: "pointer",
          flexShrink: 0,
          touchAction: "manipulation",
        }}
      >
        {initial}
      </button>
      {open && popoverPos && (
        <div
          className="theme-popover"
          role="dialog"
          aria-label="选择皮肤"
          style={{
            position: "fixed",
            top: popoverPos.top,
            left: popoverPos.left,
            zIndex: 200,
            width: 168,
            padding: 10,
            borderRadius: 10,
            border: "1px solid var(--ui-tabbar-border, #282b36)",
            background: "var(--ui-tab-active-bg, #262b38)",
            boxShadow: "0 10px 28px rgba(0,0,0,.45)",
          }}
        >
          <div style={{ fontSize: 10, color: "var(--ui-connection-text, #777b8c)", marginBottom: 8, letterSpacing: 0.5 }}>
            经典皮肤
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 7 }}>
            {WEB_THEMES.map((theme) => {
              const active = theme.id === themeId;
              return (
                <button
                  key={theme.id}
                  type="button"
                  title={theme.label}
                  aria-label={theme.label}
                  aria-pressed={active}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    onThemeChange(theme.id);
                    setOpen(false);
                  }}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    padding: "6px 2px",
                    borderRadius: 8,
                    border: active ? `2px solid var(--ui-tab-accent, #7aa2f7)` : "1px solid var(--ui-tabbar-border, #282b36)",
                    background: "var(--ui-tab-bg, #1b1e28)",
                    cursor: "pointer",
                    touchAction: "manipulation",
                  }}
                >
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      background: theme.swatch,
                      boxShadow: active ? "0 0 0 1px var(--ui-tab-accent, #7aa2f7)" : "inset 0 0 0 1px rgba(255,255,255,.08)",
                    }}
                  />
                  <span style={{ fontSize: 9.5, color: active ? "var(--ui-tab-active-text, #edf0f7)" : "var(--ui-tab-text, #8f93a4)" }}>
                    {theme.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

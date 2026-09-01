"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  // Portal target, resolved once after mount. The popover must NOT live inside
  // .terminal-tabs: that bar is overflow-y:hidden with -webkit-overflow-scrolling:
  // touch (clips fixed descendants on iOS) and .terminal-connection caps the
  // popover's stacking at z-index 5, which let terminal content paint over it.
  // Portaling into .web-root keeps the theme CSS vars (set on that element)
  // working while escaping both problems.
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalNode(rootRef.current?.closest<HTMLElement>(".web-root") ?? document.body);
  }, []);
  const initial = (username.trim()[0] ?? "?").toUpperCase();

  const syncPopoverPos = () => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = 176;
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
      // The popover is portaled outside rootRef, so it needs its own contains check
      // or pointerdown on a theme row would close it before the click lands.
      if (popoverRef.current?.contains(target)) return;
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
          border: `1px solid ${accent}`,
          background: accent,
          color: accentText,
        }}
      >
        {initial}
      </button>
      {open && popoverPos && portalNode &&
        createPortal(
        <div
          ref={popoverRef}
          className="theme-popover"
          role="dialog"
          aria-label="选择皮肤"
          style={{
            position: "fixed",
            top: popoverPos.top,
            left: popoverPos.left,
            zIndex: 200,
            width: 176,
            padding: 8,
            borderRadius: 10,
            border: "1px solid var(--ui-tabbar-border, #282b36)",
            background: "var(--ui-tab-active-bg, #262b38)",
            boxShadow: "0 10px 28px rgba(0,0,0,.45)",
          }}
        >
          <div style={{ fontSize: 10, color: "var(--ui-connection-text, #777b8c)", margin: "2px 4px 6px", letterSpacing: 0.5 }}>
            皮肤
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {WEB_THEMES.map((theme) => {
              const active = theme.id === themeId;
              return (
                <button
                  key={theme.id}
                  type="button"
                  className="theme-popover-item"
                  aria-label={theme.label}
                  aria-pressed={active}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    onThemeChange(theme.id);
                    setOpen(false);
                  }}
                  style={{
                    background: active ? "color-mix(in srgb, var(--ui-tab-accent, #7aa2f7) 14%, transparent)" : "transparent",
                  }}
                >
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 5,
                      flexShrink: 0,
                      background: `linear-gradient(135deg, ${theme.preview[0]} 55%, ${theme.preview[1]} 55%)`,
                      boxShadow: "inset 0 0 0 1px rgba(128,128,160,.25)",
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      textAlign: "left",
                      fontSize: 12,
                      fontWeight: active ? 600 : 400,
                      color: active ? "var(--ui-tab-active-text, #edf0f7)" : "var(--ui-tab-text, #8f93a4)",
                    }}
                  >
                    {theme.label}
                  </span>
                  {active && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--ui-tab-accent, #7aa2f7)"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>,
        portalNode,
      )}
    </div>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Palette } from "lucide-react";
import { WEB_THEMES, type WebThemeId } from "./themes";
import { popoverTop } from "./popover-position";

interface Props {
  themeId: WebThemeId;
  onThemeChange: (id: WebThemeId) => void;
}

export default function ThemePicker({ themeId, onThemeChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ top: -1000, left: 0 });

  useEffect(() => {
    setPortalNode(rootRef.current?.closest<HTMLElement>(".web-root") ?? document.body);
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(176, innerWidth - 16);
      const top = rootRef.current?.closest(".compact-tools-panel, .glass-tools-sheet")
        ? popoverTop(rect, popoverRef.current?.offsetHeight ?? 0, innerHeight)
        : rect.bottom + 6;
      setPosition({ top, left: Math.max(8, Math.min(innerWidth - width - 8, rect.right - width)) });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (popoverRef.current) observer.observe(popoverRef.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !popoverRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);

  return <div ref={rootRef} className="theme-picker">
    <button ref={buttonRef} type="button" className="file-drawer-toggle" aria-label="换肤" title="换肤" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
      <Palette size={17} aria-hidden="true" />
    </button>
    {open && portalNode && createPortal(<div ref={popoverRef} className="theme-popover" role="dialog" aria-label="选择皮肤" data-toolbar-overlay
      style={{ position: "fixed", ...position, zIndex: 210, width: Math.min(176, innerWidth - 16), maxHeight: "calc(100dvh - 16px)", overflowY: "auto", boxSizing: "border-box", padding: 8, borderRadius: 10, border: "1px solid var(--ui-tabbar-border, #282b36)", background: "var(--ui-tab-active-bg, #262b38)", boxShadow: "0 10px 28px rgba(0,0,0,.45)" }}>
      <div style={{ fontSize: 10, color: "var(--ui-connection-text, #777b8c)", margin: "2px 4px 6px", letterSpacing: 0.5 }}>皮肤</div>
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
    </div>, portalNode)}
  </div>;
}

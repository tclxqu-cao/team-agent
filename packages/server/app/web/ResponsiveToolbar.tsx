"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronsLeft, ChevronsRight } from "lucide-react";
import { resolveToolbarLayout } from "./toolbar-layout";

interface Props {
  items: { id: string; content: ReactNode }[];
  avatar: ReactNode;
}

export default function ResponsiveToolbar({ items, avatar }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<HTMLSpanElement>(null);
  const overflow = useRef<HTMLDivElement>(null);
  const overflowButton = useRef<HTMLButtonElement>(null);
  const slots = useRef(new Map<string, HTMLDivElement>());
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [position, setPosition] = useState({ top: -1000, left: 0 });
  const [layout, setLayout] = useState({ fullFits: false, inlineIndices: [] as number[], overflowIndices: [] as number[] });
  const inline = new Set(layout.inlineIndices);
  const showTools = layout.fullFits || expanded;
  const showOverflow = showTools && layout.overflowIndices.length > 0;

  useEffect(() => {
    setPortalNode(root.current?.closest<HTMLElement>(".web-root") ?? document.body);
  }, []);

  useLayoutEffect(() => {
    const bar = root.current?.closest<HTMLElement>(".terminal-tabs");
    const tabs = bar?.querySelector<HTMLElement>(".terminal-tab-list");
    const connection = root.current?.closest<HTMLElement>(".terminal-connection");
    if (!bar || !tabs || !connection || !portalNode) return;
    let frame = 0;
    const measure = () => {
      const barStyle = getComputedStyle(bar);
      const connectionStyle = getComputedStyle(connection);
      const tabStyle = getComputedStyle(tabs);
      const tabItems = Array.from(tabs.children) as HTMLElement[];
      const tabWidth = tabItems.reduce((total, tab) => total + tab.offsetWidth, 0)
        + Math.max(0, tabItems.length - 1) * (parseFloat(tabStyle.columnGap) || 0);
      const fixed = (parseFloat(barStyle.paddingLeft) || 0) + (parseFloat(barStyle.paddingRight) || 0)
        + (parseFloat(connectionStyle.paddingLeft) || 0) + (parseFloat(connectionStyle.paddingRight) || 0)
        + 2 * (parseFloat(barStyle.columnGap) || 0)
        + (bar.querySelector<HTMLElement>(".terminal-add")?.offsetWidth ?? 30);
      const available = bar.clientWidth - fixed;
      const next = resolveToolbarLayout({
        toolWidths: items.map(item => slots.current.get(item.id)?.offsetWidth ?? 0),
        fullAvailableWidth: available - tabWidth,
        availableWidth: available - Math.min(tabWidth, Math.max(64, Math.min(130, bar.clientWidth / 4))),
        avatarWidth: avatarRef.current?.offsetWidth ?? 44,
        toggleWidth: sizeRef.current?.offsetWidth ?? 40,
        gap: 0,
        expanded,
      });
      setLayout(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      if (next.fullFits || !expanded || next.overflowIndices.length === 0) setOverflowOpen(false);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    for (const element of [bar, tabs, root.current, overflow.current, ...slots.current.values()]) {
      if (element) observer.observe(element);
    }
    const mutations = new MutationObserver(schedule);
    mutations.observe(tabs, { childList: true, subtree: true, characterData: true });
    if (overflow.current) mutations.observe(overflow.current, { childList: true, subtree: true });
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); };
  }, [expanded, portalNode, items.length, layout.inlineIndices.join(",")]);

  useLayoutEffect(() => {
    if (!overflowOpen) return;
    const reposition = () => {
      const rect = overflowButton.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(292, innerWidth - 16);
      const barBottom = root.current?.closest(".terminal-tabs")?.getBoundingClientRect().bottom ?? rect.bottom;
      setPosition({ top: Math.max(rect.bottom, barBottom) + 6, left: Math.max(8, Math.min(innerWidth - width - 8, rect.right - width)) });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [overflowOpen, layout.inlineIndices.join(",")]);

  useEffect(() => {
    if (!overflowOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || overflow.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-toolbar-overlay]")) return;
      setOverflowOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOverflowOpen(false); overflowButton.current?.focus(); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [overflowOpen]);

  const renderItem = (item: Props["items"][number]) => <div key={item.id} className="toolbar-slot" data-toolbar-item={item.id} ref={element => {
    if (element) slots.current.set(item.id, element); else slots.current.delete(item.id);
  }}>{item.content}</div>;

  return <div ref={root} className="responsive-toolbar" data-toolbar-expanded={showTools}>
    <span ref={sizeRef} className="file-drawer-toggle toolbar-size-measure" aria-hidden="true" />
    {showOverflow && <button ref={overflowButton} type="button" className="file-drawer-toggle toolbar-overflow-toggle" aria-label="更多工具" title="更多工具" aria-haspopup="dialog" aria-expanded={overflowOpen} onClick={() => setOverflowOpen(value => !value)}><ChevronDown size={17} aria-hidden="true" /></button>}
    {layout.inlineIndices.length > 0 && <div className="toolbar-tools toolbar-tools-inline">{items.filter((_, index) => inline.has(index)).map(renderItem)}</div>}
    {!layout.fullFits && <button type="button" className="file-drawer-toggle toolbar-more" aria-label={expanded ? "收起顶部工具" : "展开顶部工具"} title={expanded ? "收起工具" : "展开工具"} aria-expanded={expanded} onClick={() => { setExpanded(value => !value); setOverflowOpen(false); }}>
      {expanded ? <ChevronsRight size={17} aria-hidden="true" /> : <ChevronsLeft size={17} aria-hidden="true" />}
    </button>}
    <div ref={avatarRef} className="toolbar-avatar" onPointerDown={() => setOverflowOpen(false)}>{avatar}</div>
    {portalNode && createPortal(<div ref={overflow} className="toolbar-overflow theme-popover" role="dialog" aria-label="更多工具菜单" data-toolbar-overlay aria-hidden={!overflowOpen}
      style={{ position: "fixed", top: overflowOpen ? position.top : -1000, left: overflowOpen ? position.left : 0, zIndex: 200, width: Math.min(292, innerWidth - 16), visibility: overflowOpen ? "visible" : "hidden", boxSizing: "border-box", maxHeight: "calc(100dvh - 60px)", overflowY: "auto", padding: 8, borderRadius: 10, border: "1px solid var(--ui-tabbar-border, #282b36)", background: "var(--ui-tab-active-bg, #262b38)", boxShadow: "0 10px 28px rgba(0,0,0,.45)" }}>
      <div className="toolbar-tools toolbar-tools-expanded">{items.filter((_, index) => !inline.has(index)).map(renderItem)}</div>
    </div>, portalNode)}
  </div>;
}

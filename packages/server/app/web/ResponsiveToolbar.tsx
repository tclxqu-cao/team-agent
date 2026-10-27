"use client";

import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronsLeft, ChevronsRight, MoreHorizontal, X } from "lucide-react";
import { resolveToolbarLayout } from "./toolbar-layout";

interface ToolbarAction { id: string; content: ReactNode }
interface ToolbarItem extends ToolbarAction { compactItems?: ToolbarAction[] }

export function compactToolbarGroups(items: ToolbarItem[]): ToolbarAction[][] {
  return items.map(item => item.compactItems ?? [item]).filter(group => group.length > 0);
}

export function glassMobileToolbarActions(items: ToolbarItem[]): ToolbarAction[] {
  return compactToolbarGroups(items).flat().filter(item => item.id !== "files");
}

interface Props {
  items: ToolbarItem[];
  avatar: ReactNode;
  glass?: boolean;
  compact?: boolean;
}

export default function ResponsiveToolbar({ items, avatar, glass = false, compact = false }: Props) {
  const [mobile, setMobile] = useState(false);
  const glassMobile = glass && mobile;
  const glassDesktop = glass && !mobile;
  useEffect(() => { setOverflowOpen(false); }, [glassMobile, compact, mobile]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 899px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
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
  const compactGroups = compactToolbarGroups(items);

  useEffect(() => {
    setPortalNode(root.current?.closest<HTMLElement>(".web-root") ?? document.body);
  }, []);

  useLayoutEffect(() => {
    const bar = root.current?.closest<HTMLElement>(".terminal-tabs");
    const tabs = bar?.querySelector<HTMLElement>(".terminal-tab-list");
    const connection = root.current?.closest<HTMLElement>(".terminal-connection");
    if (!bar || !tabs || !connection || !portalNode || glass || compact) return;
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
  }, [expanded, portalNode, items.map(item => item.id).join(","), layout.inlineIndices.join(","), glass, compact]);

  useLayoutEffect(() => {
    if (!overflowOpen) return;
    const reposition = () => {
      const rect = overflowButton.current?.getBoundingClientRect();
      if (!rect) return;
      const width = glassDesktop || compact
        ? overflow.current?.getBoundingClientRect().width ?? Math.min(292, innerWidth - 16)
        : Math.min(292, innerWidth - 16);
      const barBottom = root.current?.closest(".terminal-tabs")?.getBoundingClientRect().bottom ?? rect.bottom;
      setPosition({ top: Math.max(rect.bottom, barBottom) + 6, left: Math.max(8, Math.min(innerWidth - width - 8, rect.right - width)) });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (glassDesktop && overflow.current) observer.observe(overflow.current);
    if (compact && overflow.current) observer.observe(overflow.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [overflowOpen, glassDesktop, compact, layout.inlineIndices.join(",")]);

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

  if (compact) return <div ref={root} className="responsive-toolbar compact-toolbar">
    {compactGroups.length > 0 && <button ref={overflowButton} type="button" className="file-drawer-toggle compact-toolbar-trigger" aria-label="更多功能" title="更多功能" aria-haspopup="dialog" aria-expanded={overflowOpen} onClick={() => setOverflowOpen(value => !value)}><MoreHorizontal size={20} aria-hidden="true" /></button>}
    <div className="toolbar-avatar" onPointerDown={() => setOverflowOpen(false)}>{avatar}</div>
    {portalNode && createPortal(<div className={mobile ? "compact-tools-backdrop" : "compact-tools-overlay"} hidden={!overflowOpen} onClick={event => { if (event.target === event.currentTarget) setOverflowOpen(false); }}>
      <div ref={overflow} className={`compact-tools-panel${mobile ? " is-mobile" : ""}`} role="dialog" aria-label="更多功能" data-toolbar-overlay style={mobile ? undefined : { position: "fixed", ...position }}>
        {mobile && <header><button type="button" className="file-drawer-toggle" aria-label="关闭更多功能" title="关闭更多功能" onClick={() => { setOverflowOpen(false); overflowButton.current?.focus(); }}><X size={20} aria-hidden="true" /></button></header>}
        <div className="compact-tools-grid">{compactGroups.map(group => group.length === 1 ? renderItem(group[0]) : <div key={group[0].id} className="compact-tools-group">{group.map(renderItem)}</div>)}</div>
      </div>
    </div>, portalNode)}
  </div>;

  if (glassDesktop) {
    const primary = ["files", "remote"].flatMap(id => items.filter(item => item.id === id));
    const secondary = items.filter(item => !["files", "remote"].includes(item.id));
    return <div ref={root} className="responsive-toolbar glass-desktop-toolbar">
      <div className="glass-desktop-actions">
        {primary.map(renderItem)}
        {secondary.length > 0 && <button ref={overflowButton} type="button" className="file-drawer-toggle" aria-label="更多功能" title="更多功能" aria-haspopup="dialog" aria-expanded={overflowOpen} onClick={() => setOverflowOpen(value => !value)}><MoreHorizontal size={20} /></button>}
      </div>
      <div className="toolbar-avatar" onPointerDown={() => setOverflowOpen(false)}>{avatar}</div>
      {overflowOpen && portalNode && createPortal(<div ref={overflow} className="glass-desktop-menu" role="dialog" aria-label="更多功能" data-toolbar-overlay style={{ position: "fixed", top: position.top, left: position.left, zIndex: 200 }}>
        {secondary.map(renderItem)}
      </div>, portalNode)}
    </div>;
  }

  if (glassMobile) {
    const labels: Record<string, string> = { refresh: "刷新页面", collaboration: "群聊看板", install: "安装应用", remote: "远程桌面", "ai-hub": "AI Hub", flow: "数字人", theme: "皮肤", "navigation-layout": "切换布局", files: "我的文件" };
    const controls = <div className="glass-mobile-actions" style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button type="button" className="file-drawer-toggle ui-icon-button" aria-label="更多功能" aria-expanded={overflowOpen} onClick={() => setOverflowOpen(value => !value)}><MoreHorizontal size={20} /></button>
    </div>;
    return <div ref={root} className="responsive-toolbar glass-mobile-toolbar">
      {items.filter(item => item.id === "files").map(renderItem)}
      {controls}
      <div className="toolbar-avatar">{avatar}</div>
      {overflowOpen && portalNode && createPortal(<div className="glass-tools-backdrop" onClick={() => setOverflowOpen(false)}>
        <section className="glass-tools-sheet" role="dialog" aria-label="更多功能" data-toolbar-overlay onClick={event => event.stopPropagation()}>
          <header><strong>更多功能</strong><button type="button" aria-label="关闭更多功能" onClick={() => setOverflowOpen(false)}>×</button></header>
          <div className="glass-tools-grid">{glassMobileToolbarActions(items).map(item => <div key={item.id} className="glass-tool-cell" title={labels[item.id] ?? item.id} onClick={event => {
            if (event.target instanceof Element && event.target.closest("button")) return;
            event.currentTarget.querySelector<HTMLButtonElement>("button")?.click();
          }}>{item.content}</div>)}</div>

        </section>
      </div>, portalNode)}
    </div>;
  }

  return <div ref={root} className="responsive-toolbar" data-toolbar-expanded={showTools}>
    <span ref={sizeRef} className="file-drawer-toggle toolbar-size-measure" aria-hidden="true" />
    {showOverflow && <button ref={overflowButton} type="button" className="file-drawer-toggle toolbar-overflow-toggle" aria-label="更多工具" title="更多工具" aria-haspopup="dialog" aria-expanded={overflowOpen} onClick={() => setOverflowOpen(value => !value)}><ChevronDown size={17} aria-hidden="true" /></button>}
    {layout.inlineIndices.length > 0 && <div className="toolbar-tools toolbar-tools-inline">{items.filter((_, index) => inline.has(index)).map(renderItem)}</div>}
    {items.length > 0 && !layout.fullFits && <button type="button" className="file-drawer-toggle toolbar-more" aria-label={expanded ? "收起顶部工具" : "展开顶部工具"} title={expanded ? "收起工具" : "展开工具"} aria-expanded={expanded} onClick={() => { setExpanded(value => !value); setOverflowOpen(false); }}>
      {expanded ? <ChevronsRight size={17} aria-hidden="true" /> : <ChevronsLeft size={17} aria-hidden="true" />}
    </button>}
    <div ref={avatarRef} className="toolbar-avatar" onPointerDown={() => setOverflowOpen(false)}>{avatar}</div>
    {portalNode && createPortal(<div ref={overflow} className="toolbar-overflow theme-popover" role="dialog" aria-label="更多工具菜单" data-toolbar-overlay aria-hidden={!overflowOpen}
      style={{ position: "fixed", top: overflowOpen ? position.top : -1000, left: overflowOpen ? position.left : 0, zIndex: 200, width: Math.min(292, innerWidth - 16), visibility: overflowOpen ? "visible" : "hidden", boxSizing: "border-box", maxHeight: "calc(100dvh - 60px)", overflowY: "auto", padding: 8, borderRadius: 10, border: "1px solid var(--ui-tabbar-border, #282b36)", background: "var(--ui-tab-active-bg, #262b38)", boxShadow: "0 10px 28px rgba(0,0,0,.45)" }}>
      <div className="toolbar-tools toolbar-tools-expanded">{items.filter((_, index) => !inline.has(index)).map(renderItem)}</div>
    </div>, portalNode)}
  </div>;
}

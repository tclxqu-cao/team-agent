"use client";

import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import SortableToolbarAction from "./SortableToolbarAction";

interface ToolbarAction { id: string; content: ReactNode }
interface ToolbarItem extends ToolbarAction { compactItems?: ToolbarAction[] }
const labels: Record<string, string> = { refresh: "刷新页面", dashboard: "进行中的会话", messaging: "消息接入", collaboration: "群聊看板", install: "安装应用", remote: "远程桌面", "ai-hub": "AI Hub", flow: "数字人", theme: "皮肤", files: "我的文件" };

export function compactToolbarGroups(items: ToolbarItem[]): ToolbarAction[][] {
  return items.map(item => item.compactItems ?? [item]).filter(group => group.length > 0);
}

export function glassMobileToolbarActions(items: ToolbarItem[]): ToolbarAction[] {
  return compactToolbarGroups(items).flat().filter(item => item.id !== "files");
}

interface Props {
  items: ToolbarItem[];
  avatar: ReactNode;
  onReorder?: (source: string, target: string) => Promise<void>;
  sortingDisabled?: boolean;
}

export default function ResponsiveToolbar({ items, avatar, onReorder, sortingDisabled = false }: Props) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => { setOverflowOpen(false); }, [mobile]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 899px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const root = useRef<HTMLDivElement>(null);
  const overflow = useRef<HTMLDivElement>(null);
  const overflowButton = useRef<HTMLButtonElement>(null);
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [position, setPosition] = useState({ top: -1000, left: 0 });
  const [sortError, setSortError] = useState("");
  const move = (source: string, target: string) => {
    if (!onReorder || sortingDisabled) return;
    setSortError("");
    void onReorder(source, target).catch(cause => setSortError(cause instanceof Error ? cause.message : "顺序保存失败，请重试。"));
  };
  const sortableItem = (item: ToolbarAction, className: string) => <SortableToolbarAction
    key={item.id} id={item.id} label={labels[item.id] ?? item.id} className={className}
    disabled={!onReorder || sortingDisabled} onMove={move}>{renderItem(item)}</SortableToolbarAction>;

  useEffect(() => {
    setPortalNode(root.current?.closest<HTMLElement>(".web-root") ?? document.body);
  }, []);

  useLayoutEffect(() => {
    if (!overflowOpen || mobile) return;
    const reposition = () => {
      const rect = overflowButton.current?.getBoundingClientRect();
      if (!rect) return;
      const width = overflow.current?.getBoundingClientRect().width ?? Math.min(292, innerWidth - 16);
      const barBottom = root.current?.closest(".terminal-tabs")?.getBoundingClientRect().bottom ?? rect.bottom;
      setPosition({ top: Math.max(rect.bottom, barBottom) + 6, left: Math.max(8, Math.min(innerWidth - width - 8, rect.right - width)) });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (overflow.current) observer.observe(overflow.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true); };
  }, [overflowOpen, mobile]);

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

  const renderItem = (item: ToolbarAction) => <div key={item.id} className="toolbar-slot" data-toolbar-item={item.id} onClick={item.id === "remote" ? () => setOverflowOpen(false) : undefined}>{item.content}</div>;

  if (!mobile) {
    const primary = ["files", "remote"].flatMap(id => items.filter(item => item.id === id));
    const secondary = items.filter(item => !["files", "remote"].includes(item.id));
    return <div ref={root} className="responsive-toolbar glass-desktop-toolbar">
      <div className="glass-desktop-actions">
        {primary.map(renderItem)}
        {secondary.length > 0 && <button ref={overflowButton} type="button" className="file-drawer-toggle" aria-label="更多功能" title="更多功能" aria-haspopup="dialog" aria-expanded={overflowOpen} onClick={() => setOverflowOpen(value => !value)}><MoreHorizontal size={20} /></button>}
      </div>
      <div className="toolbar-avatar" onPointerDown={() => setOverflowOpen(false)}>{avatar}</div>
      {portalNode && createPortal(<div ref={overflow} hidden={!overflowOpen} className="glass-desktop-menu" role="dialog" aria-label="更多功能" data-toolbar-overlay style={{ position: "fixed", top: position.top, left: position.left, zIndex: 200 }}>
        {secondary.map(item => sortableItem(item, "toolbar-sort-cell"))}
        {sortError && <p className="toolbar-sort-error" role="alert">{sortError}</p>}
      </div>, portalNode)}
    </div>;
  }

  {
    const controls = <div className="glass-mobile-actions" style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button ref={overflowButton} type="button" className="file-drawer-toggle ui-icon-button" aria-haspopup="dialog" aria-label="更多功能" aria-expanded={overflowOpen} onClick={() => setOverflowOpen(value => !value)}><MoreHorizontal size={20} /></button>
    </div>;
    return <div ref={root} className="responsive-toolbar glass-mobile-toolbar">
      {items.filter(item => item.id === "files").map(renderItem)}
      {controls}
      <div className="toolbar-avatar">{avatar}</div>
      {portalNode && createPortal(<div hidden={!overflowOpen} className="glass-tools-backdrop" onClick={() => setOverflowOpen(false)}>
        <section ref={overflow} className="glass-tools-sheet" role="dialog" aria-label="更多功能" data-toolbar-overlay onClick={event => event.stopPropagation()}>
          <header><div><strong>更多功能</strong><small>长按拖动排序</small></div><button type="button" aria-label="关闭更多功能" onClick={() => { setOverflowOpen(false); overflowButton.current?.focus(); }}>×</button></header>
          <div className="glass-tools-grid">{glassMobileToolbarActions(items).map(item => sortableItem(item, "glass-tool-cell"))}</div>
          {sortError && <p className="toolbar-sort-error" role="alert">{sortError}</p>}

        </section>
      </div>, portalNode)}
    </div>;
  }

}

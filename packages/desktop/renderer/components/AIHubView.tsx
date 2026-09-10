import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computePaneRects, type HubRect } from "../lib/ai-hub-layout";
import type { HubBroadcastResult, HubConfig, HubEvent, HubSite } from "../global";

const TOP_BAR_HEIGHT = 52;
const PANE_HEADER_HEIGHT = 30;
const MAX_COMPARE = 4;
const MIN_COMPARE = 2;

type HubMode = "single" | "compare";

interface AIHubViewProps {
  onExit: () => void;
}

interface SendChip {
  siteId: string;
  ok: boolean;
  reason?: string;
  at: number;
}

function avatarLetter(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// 桌面端专属：WebContentsView 承载各站点页面，本组件只画外壳并推送格子矩形。
// web shell（无 agentApi.hub*）降级为提示文案。
export default function AIHubView({ onExit }: AIHubViewProps) {
  const api = typeof window !== "undefined" ? window.agentApi : undefined;
  const hubAvailable = typeof api?.hubGetConfig === "function";

  const [sites, setSites] = useState<HubSite[]>([]);
  const [mode, setMode] = useState<HubMode>("single");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [segments, setSegments] = useState<number[]>([]);
  const [containerRect, setContainerRect] = useState<HubRect | null>(null);
  const [failed, setFailed] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [googleBlocked, setGoogleBlocked] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [chips, setChips] = useState<SendChip[]>([]);
  const [barCollapsed, setBarCollapsed] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const containerRef = useRef<HTMLDivElement | null>(null);
  const boundsFrame = useRef(0);

  const visibleIds = useMemo(() => {
    if (mode === "single") return activeId ? [activeId] : [];
    return compareIds.slice(0, MAX_COMPARE);
  }, [mode, activeId, compareIds]);

  const paneRects = useMemo(() => {
    if (!containerRect) return [];
    return computePaneRects(containerRect, visibleIds.length, segments);
  }, [containerRect, visibleIds.length, segments]);

  // 布局推送：pane 矩形去掉 DOM 头部高度后才是网页视图矩形
  useEffect(() => {
    if (!hubAvailable || paneRects.length === 0) return;
    const panes = visibleIds.map((siteId, index) => {
      const rect = paneRects[index];
      return {
        siteId,
        x: rect.x,
        y: rect.y + PANE_HEADER_HEIGHT,
        width: rect.width,
        height: Math.max(rect.height - PANE_HEADER_HEIGHT, 0),
      };
    });
    void api?.hubSetBounds(panes);
  }, [hubAvailable, api, paneRects, visibleIds]);

  // 打开当前布局中的站点（幂等；被移出的视图由 setBounds([]) 外的主进程逻辑隐藏）
  useEffect(() => {
    if (!hubAvailable) return;
    for (const siteId of visibleIds) void api?.hubOpenSite(siteId);
  }, [hubAvailable, api, visibleIds]);

  // 容器尺寸测量：ResizeObserver + rAF 节流
  useEffect(() => {
    if (!hubAvailable) return;
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setContainerRect((previous) => {
        if (
          previous &&
          Math.abs(previous.x - rect.x) < 0.5 &&
          Math.abs(previous.y - rect.y) < 0.5 &&
          Math.abs(previous.width - rect.width) < 0.5 &&
          Math.abs(previous.height - rect.height) < 0.5
        ) {
          return previous;
        }
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
    };
    const frame = { current: 0 };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(measure);
    });
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [hubAvailable, barCollapsed, formOpen]);

  // 配置 + 事件订阅 + 退出清理
  useEffect(() => {
    if (!hubAvailable || !api) return;
    let disposed = false;
    void api.hubGetConfig().then((config: HubConfig) => {
      if (disposed) return;
      setSites(config.sites);
      setActiveId((current) => current ?? config.sites[0]?.id ?? null);
    });
    const unsubscribe = api.onHubEvent((event: HubEvent) => {
      if (event.type === "load-failed") {
        setFailed((previous) => ({ ...previous, [event.siteId]: event.errorCode ?? -1 }));
        setLoading((previous) => ({ ...previous, [event.siteId]: false }));
      } else if (event.type === "loaded") {
        setFailed((previous) => {
          if (!(event.siteId in previous)) return previous;
          const next = { ...previous };
          delete next[event.siteId];
          return next;
        });
        setLoading((previous) => ({ ...previous, [event.siteId]: false }));
      } else if (event.type === "loading") {
        setLoading((previous) => ({ ...previous, [event.siteId]: true }));
      } else if (event.type === "title") {
        // Google 在嵌入式浏览器中封锁账号登录（signin/rejected / 无法登录），给出明确引导而不是死页面
        const googleBlocked = event.title.includes("无法登录") || event.title.includes("可能不安全");
        setGoogleBlocked((previous) => {
          if (googleBlocked === (event.siteId in previous && previous[event.siteId])) return previous;
          const next = { ...previous };
          if (googleBlocked) next[event.siteId] = true;
          else delete next[event.siteId];
          return next;
        });
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
      void api.hubHideAll();
    };
  }, [hubAvailable, api]);

  // 对比数量变化时重置分屏占比为等分
  useEffect(() => {
    const count = Math.max(visibleIds.length, 0);
    setSegments((previous) => (previous.length === count ? previous : Array.from({ length: count }, () => (count > 0 ? 1 / count : 0))));
  }, [visibleIds.length]);

  const toggleSite = useCallback((siteId: string) => {
    if (mode === "single") {
      setActiveId(siteId);
      return;
    }
    setCompareIds((current) => {
      if (current.includes(siteId)) return current.filter((id) => id !== siteId);
      if (current.length >= MAX_COMPARE) return current;
      return [...current, siteId];
    });
  }, [mode]);

  const switchMode = useCallback((next: HubMode) => {
    setMode((current) => {
      if (current === next) return current;
      if (next === "compare") {
        setCompareIds(() => {
          const base = activeId ? [activeId] : [];
          for (const site of sites) {
            if (base.length >= MIN_COMPARE) break;
            if (!base.includes(site.id)) base.push(site.id);
          }
          return base;
        });
      } else {
        setActiveId((previous) => previous ?? compareIds[0] ?? sites[0]?.id ?? null);
      }
      return next;
    });
  }, [activeId, compareIds, sites]);

  const retrySite = useCallback((siteId: string) => {
    setFailed((previous) => {
      const next = { ...previous };
      delete next[siteId];
      return next;
    });
    void api?.hubReload(siteId);
    void api?.hubOpenSite(siteId);
  }, [api]);

  const closePane = useCallback((siteId: string) => {
    void api?.hubCloseSite(siteId);
    if (mode === "single") {
      const fallback = sites.find((site) => site.id !== siteId)?.id ?? null;
      setActiveId(fallback);
      return;
    }
    setCompareIds((current) => {
      const next = current.filter((id) => id !== siteId);
      if (next.length < MIN_COMPARE) {
        setMode("single");
        setActiveId(next[0] ?? sites.find((site) => site.id !== siteId)?.id ?? null);
        return [];
      }
      return next;
    });
  }, [api, mode, sites]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !api || sending || visibleIds.length === 0) return;
    setSending(true);
    try {
      const results: HubBroadcastResult[] = await api.hubBroadcast(text, visibleIds);
      const stamped = results.map((result) => ({ ...result, at: Date.now() }));
      setChips(stamped);
      if (results.some((result) => result.ok)) setDraft("");
      setTimeout(() => {
        setChips((previous) => previous.filter((chip) => Date.now() - chip.at < 8000));
      }, 8200);
    } finally {
      setSending(false);
    }
  }, [api, draft, sending, visibleIds]);

  const addSite = useCallback(async () => {
    if (!api || !isValidHttpUrl(newUrl)) return;
    const url = newUrl.trim();
    const name = newName.trim() || new URL(url).hostname;
    const site: HubSite = {
      id: `custom-${Math.random().toString(36).slice(2, 10)}`,
      name,
      url,
      adapter: "generic",
    };
    const config = await api.hubSetConfig({ version: 1, sites: [...sites, site] });
    setSites(config.sites);
    setNewName("");
    setNewUrl("");
    setFormOpen(false);
  }, [api, newName, newUrl, sites]);

  const removeSite = useCallback(async (siteId: string) => {
    if (!api || sites.length <= 1) return;
    void api.hubCloseSite(siteId);
    const config = await api.hubSetConfig({ version: 1, sites: sites.filter((site) => site.id !== siteId) });
    setSites(config.sites);
    setActiveId((current) => (current === siteId ? config.sites[0]?.id ?? null : current));
    setCompareIds((current) => current.filter((id) => id !== siteId));
  }, [api, sites]);

  const startDividerDrag = useCallback((index: number, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const paneCount = paneRects.length;
    const gap = paneCount > 1 ? 8 : 0;
    const usable = (containerRect?.width ?? 0) - gap * (paneCount - 1);
    if (usable <= 0) return;
    const startX = event.clientX;
    const startSegments = [...segments];
    const startLeftPx = paneRects[index].width;
    const pairFraction = startSegments[index] + startSegments[index + 1];
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const minPx = 80;
      const pairPx = pairFraction * usable;
      const left = Math.min(Math.max(startLeftPx + delta, minPx), pairPx - minPx);
      const next = [...startSegments];
      next[index] = left / usable;
      next[index + 1] = (pairPx - left) / usable;
      setSegments(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [segments, paneRects, containerRect]);

  if (!hubAvailable) {
    return (
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "var(--bg-workspace)", zIndex: 30 }}>
        <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 13, display: "grid", gap: 12 }}>
          <span>AI Hub 仅在桌面端可用</span>
          <button type="button" onClick={onExit} className="ui-icon-button ui-icon-button--auto" style={{ justifySelf: "center", padding: "6px 14px" }}>
            返回
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", flexDirection: "column", background: "var(--bg-workspace)" }}>
      {/* 顶栏（与全局拖拽区重叠，按钮需 no-drag） */}
      <div
        className="aihub-topbar"
        style={{
          height: TOP_BAR_HEIGHT,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          borderBottom: "1px solid var(--border-subtle)",
          WebkitAppRegion: "drag",
        } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={onExit}
          title="返回对话"
          aria-label="返回对话"
          className="ui-icon-button ui-icon-button--auto"
          style={{ WebkitAppRegion: "no-drag", padding: "5px 10px", whiteSpace: "nowrap" } as React.CSSProperties}
        >
          ← 返回
        </button>
        <strong style={{ fontSize: 14, color: "var(--text-secondary)" }}>AI Hub</strong>
        <span style={{ flex: 1 }} />
        <div
          role="tablist"
          aria-label="布局模式"
          style={{ display: "flex", gap: 4, WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {(["single", "compare"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => switchMode(value)}
              className={`ui-icon-button ui-icon-button--auto ${mode === value ? "is-active" : ""}`}
              style={{ padding: "5px 12px", fontSize: 12 }}
            >
              {value === "single" ? "单屏" : "对比"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 站点栏 */}
        <aside style={{ width: 200, borderRight: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", overflow: "auto", padding: "10px 8px", gap: 4 }}>
          {sites.map((site) => {
            const checked = visibleIds.includes(site.id);
            const custom = site.id.startsWith("custom-");
            return (
              <div
                key={site.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 8px",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: checked ? "var(--bg-glass)" : "transparent",
                  border: `1px solid ${checked ? "var(--border-default)" : "transparent"}`,
                }}
                onClick={() => toggleSite(site.id)}
                role="option"
                aria-selected={checked}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    display: "grid",
                    placeItems: "center",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    background: "var(--accent-glow)",
                    flexShrink: 0,
                  }}
                >
                  {avatarLetter(site.name)}
                </span>
                <span style={{ flex: 1, fontSize: 13, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {site.name}
                </span>
                {mode === "compare" && (
                  <input type="checkbox" readOnly checked={checked} tabIndex={-1} style={{ pointerEvents: "none" }} />
                )}
                {custom && (
                  <button
                    type="button"
                    title="删除站点"
                    aria-label={`删除站点 ${site.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeSite(site.id);
                    }}
                    className="ui-icon-button"
                    style={{ padding: 2, fontSize: 11, lineHeight: 1 }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          {formOpen ? (
            <div style={{ display: "grid", gap: 6, padding: "8px 4px" }}>
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="名称（可选）"
                style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border-default)", background: "transparent", color: "var(--text-secondary)", fontSize: 12 }}
              />
              <input
                value={newUrl}
                onChange={(event) => setNewUrl(event.target.value)}
                placeholder="https://…"
                style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border-default)", background: "transparent", color: "var(--text-secondary)", fontSize: 12 }}
              />
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={() => void addSite()} disabled={!isValidHttpUrl(newUrl)} className="ui-icon-button ui-icon-button--auto" style={{ padding: "5px 10px", fontSize: 12, whiteSpace: "nowrap" }}>
                  添加
                </button>
                <button type="button" onClick={() => setFormOpen(false)} className="ui-icon-button ui-icon-button--auto" style={{ padding: "5px 10px", fontSize: 12, whiteSpace: "nowrap" }}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setFormOpen(true)} className="ui-icon-button ui-icon-button--auto" style={{ padding: "7px 8px", fontSize: 12, textAlign: "left", whiteSpace: "nowrap" }}>
              ＋ 添加站点
            </button>
          )}
          {mode === "compare" && (
            <span style={{ fontSize: 11, color: "var(--text-muted)", padding: "6px 4px" }}>
              勾选 {MIN_COMPARE}-{MAX_COMPARE} 个站点对比
            </span>
          )}
        </aside>

        {/* 分屏区 */}
        <div ref={containerRef} style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {paneRects.map((rect, index) => {
            const siteId = visibleIds[index];
            const site = sites.find((candidate) => candidate.id === siteId);
            const hasFailed = siteId in failed;
            return (
              <div
                key={siteId}
                data-aihub-pane={siteId}
                style={{
                  position: "absolute",
                  left: rect.x - (containerRect?.x ?? 0),
                  top: rect.y - (containerRect?.y ?? 0),
                  width: rect.width,
                  height: rect.height,
                  display: "flex",
                  flexDirection: "column",
                  borderRight: index < paneRects.length - 1 ? "1px solid var(--border-subtle)" : undefined,
                }}
              >
                <div
                  style={{
                    height: PANE_HEADER_HEIGHT,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 8px",
                    borderBottom: "1px solid var(--border-subtle)",
                    fontSize: 12,
                    color: "var(--text-secondary)",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: hasFailed ? "#f7768e" : loading[siteId] ? "var(--accent-glow)" : "#9ece6a",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{site?.name ?? siteId}</span>
                  {googleBlocked[siteId] && (
                    <span
                      title="Google 限制嵌入式浏览器登录此页面。请使用站点的邮箱/密码登录方式，或先在系统浏览器完成站点登录。"
                      aria-label="Google 登录受限"
                      style={{
                        flexShrink: 0,
                        fontSize: 10,
                        padding: "1px 6px",
                        borderRadius: 999,
                        color: "#f7768e",
                        border: "1px solid currentColor",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: 180,
                      }}
                    >
                      Google 登录受限，建议邮箱登录
                    </span>
                  )}
                  <button type="button" title="刷新" aria-label={`刷新 ${site?.name ?? siteId}`} onClick={() => retrySite(siteId)} className="ui-icon-button" style={{ padding: 2 }}>
                    ⟳
                  </button>
                  <button type="button" title="关闭页面" aria-label={`关闭 ${site?.name ?? siteId}`} onClick={() => closePane(siteId)} className="ui-icon-button" style={{ padding: 2 }}>
                    ×
                  </button>
                </div>
                {/* 网页宿主：WebContentsView 盖在此处；失败时视图被主进程移除，错误层可见 */}
                <div style={{ flex: 1, position: "relative", background: "var(--bg-surface)" }}>
                  {hasFailed && (
                    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                      <div style={{ textAlign: "center", display: "grid", gap: 10, color: "var(--text-muted)", fontSize: 12 }}>
                        <span>页面加载失败（{failed[siteId]}）</span>
                        <button type="button" onClick={() => retrySite(siteId)} className="ui-icon-button ui-icon-button--auto" style={{ justifySelf: "center", padding: "5px 12px" }}>
                          重试
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {/* 分隔条 */}
                {index < paneRects.length - 1 && (
                  <div
                    data-aihub-divider={index}
                    onPointerDown={(event) => startDividerDrag(index, event)}
                    title="拖动调整宽度"
                    style={{ position: "absolute", top: 0, bottom: 0, right: -5, width: 10, cursor: "col-resize", zIndex: 5 }}
                  />
                )}
              </div>
            );
          })}
          {paneRects.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--text-muted)", fontSize: 13 }}>
              {mode === "compare" ? `在左侧勾选 ${MIN_COMPARE}-${MAX_COMPARE} 个站点开始对比` : "在左侧选择一个站点"}
            </div>
          )}
        </div>
      </div>

      {/* 同步发送条 */}
      {barCollapsed ? (
        <button
          type="button"
          onClick={() => setBarCollapsed(false)}
          className="ui-icon-button ui-icon-button--auto"
          style={{ alignSelf: "flex-end", margin: 6, padding: "4px 10px", fontSize: 12, whiteSpace: "nowrap" }}
        >
          ⬆ 同步发送
        </button>
      ) : (
        <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-surface)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
              }}
              rows={2}
              placeholder={`一次输入，同步发送到 ${visibleIds.length} 个站点（⌘⏎ 发送）`}
              style={{ flex: 1, resize: "none", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--border-default)", background: "var(--bg-workspace)", color: "var(--text-primary)", fontSize: 13, lineHeight: 1.5 }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim() || sending || visibleIds.length === 0}
                className="ui-icon-button ui-icon-button--auto"
                style={{ height: 38, padding: "0 18px", fontSize: 13, whiteSpace: "nowrap", borderRadius: 8, background: "var(--accent-glow)", color: "var(--text-primary)", fontWeight: 600 }}
              >
                {sending ? "发送中…" : "同步发送"}
              </button>
              <button
                type="button"
                onClick={() => setBarCollapsed(true)}
                title="收起"
                aria-label="收起同步发送条"
                className="ui-icon-button ui-icon-button--auto"
                style={{ height: 24, padding: "0 10px", fontSize: 11, whiteSpace: "nowrap" }}
              >
                ⬇ 收起
              </button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", minHeight: 18 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>接收方</span>
            {visibleIds.map((siteId) => {
              const site = sites.find((candidate) => candidate.id === siteId);
              return (
                <span key={siteId} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 999, background: "var(--bg-glass)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                  {site?.name ?? siteId}
                </span>
              );
            })}
            {chips.map((chip) => (
              <span
                key={chip.siteId}
                role="status"
                style={{
                  fontSize: 11,
                  padding: "3px 10px",
                  borderRadius: 999,
                  color: chip.ok ? "#9ece6a" : "#f7768e",
                  background: "var(--bg-glass)",
                  whiteSpace: "nowrap",
                }}
              >
                {(sites.find((candidate) => candidate.id === chip.siteId)?.name ?? chip.siteId)
                + (chip.ok ? " ✓" : ` ✕ ${chip.reason ?? "失败"}`)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

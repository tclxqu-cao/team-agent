import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Paperclip, Plus, Send, Trash2, X } from "lucide-react";
import { MAX_RELAY_IMAGES, MAX_RELAY_IMAGE_LENGTH } from "../../../core/src/domain/ai-hub/image-limits";
import { computePaneRects, type HubRect } from "../lib/ai-hub-layout";
import ChromeHubPane from "./ChromeHubPane";
import ChromeHubSetup from "./ChromeHubSetup";
import { isChromeHubSite } from "../../main/ai-hub/chrome-bridge-protocol";
import type {
  HubBroadcastResult,
  HubConfig,
  HubEvent,
  HubSite,
} from "../global";

const TOP_BAR_HEIGHT = 52;
const PANE_HEADER_HEIGHT = 30;
const MAX_COMPARE = 4;

interface AIHubViewProps {
  onExit: () => void;
}

interface SendChip {
  siteId: string;
  ok: boolean;
  reason?: string;
  at: number;
}

export function toggleHubSiteSelection(current: string[], siteId: string): string[] {
  if (current.includes(siteId)) {
    return current.length > 1 ? current.filter((id) => id !== siteId) : current;
  }
  return current.length < MAX_COMPARE ? [...current, siteId] : current;
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
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [segments, setSegments] = useState<number[]>([]);
  const [containerRect, setContainerRect] = useState<HubRect | null>(null);
  const [failed, setFailed] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [googleBlocked, setGoogleBlocked] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [readingImages, setReadingImages] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [chips, setChips] = useState<SendChip[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [chromeSetupOpen, setChromeSetupOpen] = useState(false);
  const [chromeConnectedSites, setChromeConnectedSites] = useState<string[]>([]);
  useEffect(() => {
    if (!api?.hubChromeStatus) return;
    let disposed = false;
    const apply = (status: { compatible?: boolean; tabs: Array<{ siteId: string }> }) => { if (!disposed) setChromeConnectedSites(status.compatible === false ? [] : status.tabs.map((tab) => tab.siteId)); };
    void api.hubChromeStatus().then(apply);
    const unsubscribe = api.onHubChromeEvent((event) => { if (event.type === "chrome-status") apply(event.status); });
    return () => { disposed = true; unsubscribe(); };
  }, [api]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const boundsFrame = useRef(0);

  useLayoutEffect(() => {
    const input = draftRef.current;
    if (!input) return;
    // Placeholder wrapping must not enlarge an empty composer.
    input.style.height = "32px";
    if (draft) input.style.height = `${Math.max(32, Math.min(input.scrollHeight, 120))}px`;
  }, [draft, selectedIds.length]);

  const addImages = async (files: File[]) => {
    if (sending || readingImages) return;
    setReadingImages(true);
    setAttachmentError("");
    try {
      if (files.length + images.length > MAX_RELAY_IMAGES) throw new Error(`最多添加 ${MAX_RELAY_IMAGES} 张图片`);
      const added = await Promise.all(files.map(async (file) => {
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
        if (file.size * 4 / 3 + 32 > MAX_RELAY_IMAGE_LENGTH) throw new Error("单张图片不能超过约 3 MB");
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("图片读取失败，请重试"));
          reader.readAsDataURL(file);
        });
      }));
      setImages((current) => [...current, ...added].slice(0, MAX_RELAY_IMAGES));
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "图片读取失败");
    } finally {
      setReadingImages(false);
    }
  };

  const paneRects = useMemo(() => {
    if (!containerRect) return [];
    return computePaneRects(containerRect, selectedIds.length, segments);
  }, [containerRect, selectedIds.length, segments]);

  // 布局推送：pane 矩形去掉 DOM 头部高度后才是网页视图矩形
  useEffect(() => {
    if (!hubAvailable || paneRects.length === 0) return;
    const panes = selectedIds.map((siteId, index) => {
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
  }, [hubAvailable, api, paneRects, selectedIds]);

  // 打开当前布局中的站点（幂等；被移出的视图由 setBounds([]) 外的主进程逻辑隐藏）
  useEffect(() => {
    if (!hubAvailable) return;
    for (const siteId of selectedIds) void api?.hubOpenSite(siteId);
  }, [hubAvailable, api, selectedIds]);

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
  }, [hubAvailable, formOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const closeOnRendererBlur = () => setPickerOpen(false);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("blur", closeOnRendererBlur);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("blur", closeOnRendererBlur);
    };
  }, [pickerOpen]);

  // 配置 + 事件订阅 + 退出清理
  useEffect(() => {
    if (!hubAvailable || !api) return;
    let disposed = false;
    void api.hubGetConfig().then((config: HubConfig) => {
      if (disposed) return;
      setSites(config.sites);
      setSelectedIds((current) => current.length > 0 ? current : config.sites.slice(0, 1).map((site) => site.id));
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
        setGoogleBlocked((previous) => {
          if (!(event.siteId in previous)) return previous;
          const next = { ...previous };
          delete next[event.siteId];
          return next;
        });
      } else if (event.type === "google-auth-external") {
        setGoogleBlocked((previous) => ({ ...previous, [event.siteId]: true }));

      }
    });
    return () => {
      disposed = true;
      unsubscribe();
      void api.hubHideAll();
    };
  }, [hubAvailable, api]);

  // 选择数量变化时重置分屏占比为等分
  useEffect(() => {
    const count = Math.max(selectedIds.length, 0);
    setSegments((previous) => (previous.length === count ? previous : Array.from({ length: count }, () => (count > 0 ? 1 / count : 0))));
  }, [selectedIds.length]);

  const toggleSite = useCallback((siteId: string) => {
    setSelectedIds((current) => toggleHubSiteSelection(current, siteId));
  }, []);

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
    if (selectedIds.length <= 1) return;
    void api?.hubCloseSite(siteId);
    setSelectedIds((current) => current.filter((id) => id !== siteId));
  }, [api, selectedIds.length]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && images.length === 0) || !api || sending || readingImages || selectedIds.length === 0) return;
    setSending(true);
    try {
      const results: HubBroadcastResult[] = await api.hubBroadcast(text, selectedIds, images);
      const stamped = results.map((result) => ({ ...result, at: Date.now() }));
      setChips(stamped);
      if (results.length > 0 && results.every((result) => result.ok)) {
        setDraft("");
        setImages([]);
        setAttachmentError("");
      }
      setTimeout(() => {
        setChips((previous) => previous.filter((chip) => !chip.ok || Date.now() - chip.at < 8000));
      }, 8200);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "发送失败，请重试");
    } finally {
      setSending(false);
    }
  }, [api, draft, images, readingImages, sending, selectedIds]);

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
    setSelectedIds((current) => {
      const next = current.filter((id) => id !== siteId);
      return next.length > 0 ? next : config.sites.slice(0, 1).map((site) => site.id);
    });
  }, [api, sites]);

  const startDividerDrag = useCallback((index: number, event: React.PointerEvent<HTMLDivElement>) => {    event.preventDefault();
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
        <button type="button" className="ui-icon-button ui-icon-button--auto" onClick={() => setChromeSetupOpen((open) => !open)}
          style={{ WebkitAppRegion: "no-drag", marginLeft: "auto", padding: "5px 10px" } as React.CSSProperties}>连接 Chrome</button>
      </div>

      {chromeSetupOpen && <ChromeHubSetup onClose={() => setChromeSetupOpen(false)} />}

      {/* 单选铺满，多选自动进入分屏 */}
      <div ref={containerRef} style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0 }}>
          {paneRects.map((rect, index) => {
            const siteId = selectedIds[index];
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
                      background: isChromeHubSite(siteId) ? (chromeConnectedSites.includes(siteId) ? "var(--success)" : "var(--text-muted)") : hasFailed ? "#f7768e" : loading[siteId] ? "var(--accent-glow)" : "#9ece6a",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 40, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{site?.name ?? siteId}</span>
                  {googleBlocked[siteId] && (
                    <span
                      title="Google 登录已在系统浏览器打开，登录状态不会同步回 AI Hub。如需继续内嵌使用，请选择邮箱登录。"
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
                      Google 登录已转至浏览器，内嵌请用邮箱
                    </span>
                  )}
                  {isChromeHubSite(siteId) && (
                    <button type="button" aria-label={`打开 ${site?.name ?? siteId} Chrome 页面`} title="在日常 Chrome 中登录或查看页面" className="ui-icon-button ui-icon-button--auto"
                      onClick={() => { void api.hubOpenChrome(siteId).catch(() => setChromeSetupOpen(true)); }} style={{ padding: "2px 6px", fontSize: 11 }}>Chrome ↗</button>
                  )}
                  <button type="button" title="刷新" aria-label={`刷新 ${site?.name ?? siteId}`} onClick={() => retrySite(siteId)} className="ui-icon-button" style={{ padding: 2 }}>
                    ⟳
                  </button>
                  {selectedIds.length > 1 && (
                    <button type="button" title="关闭页面" aria-label={`关闭 ${site?.name ?? siteId}`} onClick={() => closePane(siteId)} className="ui-icon-button" style={{ padding: 2 }}>
                      ×
                    </button>
                  )}
                </div>
                {/* 网页宿主：WebContentsView 盖在此处；失败时视图被主进程移除，错误层可见 */}
                <div style={{ flex: 1, position: "relative", background: "var(--bg-surface)" }}>
                  {isChromeHubSite(siteId) && <ChromeHubPane siteId={siteId} name={site?.name ?? siteId} onSetup={() => setChromeSetupOpen(true)} />}
                  {!isChromeHubSite(siteId) && hasFailed && (
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
              从输入框选择一个 AI 站点
            </div>
          )}
      </div>

      {/* 输入区必须为下拉预留真实高度，避免 WebContentsView 覆盖 DOM 菜单。 */}
      <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "8px 12px 10px", display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-surface)" }}>
        <div
          ref={pickerRef}
          style={{ position: "relative", display: "flex", flexDirection: "column", gap: 8 }}
        >
          {pickerOpen && (
            <div
              role="listbox"
              aria-label="选择要发送的 AI 站点"
              data-aihub-site-picker=""
              style={{
                width: "min(320px, 100%)",
                maxHeight: 280,
                overflowY: "auto",
                padding: 4,
                border: "1px solid var(--border-default)",
                borderRadius: 8,
                background: "var(--bg-workspace)",
                boxShadow: "0 -8px 24px rgba(0, 0, 0, 0.12)",
              }}
            >
              {sites.map((site) => {
                const selected = selectedIds.includes(site.id);
                const custom = site.id.startsWith("custom-");
                return (
                  <div key={site.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => toggleSite(site.id)}
                      style={{
                        minWidth: 0,
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 9px",
                        border: 0,
                        borderRadius: 6,
                        background: selected ? "var(--bg-glass)" : "transparent",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 20,
                          height: 20,
                          display: "grid",
                          placeItems: "center",
                          borderRadius: "50%",
                          border: `1px solid ${selected ? "var(--accent)" : "var(--border-default)"}`,
                          background: selected ? "var(--accent)" : "transparent",
                          color: selected ? "var(--bg-workspace)" : "transparent",
                          flexShrink: 0,
                        }}
                      >
                        <Check size={13} strokeWidth={2.5} />
                      </span>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 24,
                          height: 24,
                          display: "grid",
                          placeItems: "center",
                          borderRadius: 6,
                          background: "var(--accent-glow)",
                          fontSize: 12,
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {avatarLetter(site.name)}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{site.name}</span>
                    </button>
                    {custom && (
                      <button
                        type="button"
                        title={`删除站点 ${site.name}`}
                        aria-label={`删除站点 ${site.name}`}
                        onClick={() => void removeSite(site.id)}
                        className="ui-icon-button"
                        style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}

              <div style={{ height: 1, margin: "4px 6px", background: "var(--border-subtle)" }} />
              {formOpen ? (
                <div style={{ display: "grid", gap: 6, padding: 6 }}>
                  <input
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="名称（可选）"
                    style={{ minWidth: 0, padding: "7px 8px", borderRadius: 6, border: "1px solid var(--border-default)", background: "var(--bg-surface)", color: "var(--text-secondary)", fontSize: 12 }}
                  />
                  <input
                    value={newUrl}
                    onChange={(event) => setNewUrl(event.target.value)}
                    placeholder="https://..."
                    style={{ minWidth: 0, padding: "7px 8px", borderRadius: 6, border: "1px solid var(--border-default)", background: "var(--bg-surface)", color: "var(--text-secondary)", fontSize: 12 }}
                  />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button type="button" onClick={() => void addSite()} disabled={!isValidHttpUrl(newUrl)} className="ui-icon-button ui-icon-button--auto" style={{ padding: "5px 10px", fontSize: 12 }}>
                      添加
                    </button>
                    <button type="button" onClick={() => setFormOpen(false)} className="ui-icon-button ui-icon-button--auto" style={{ padding: "5px 10px", fontSize: 12 }}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setFormOpen(true)}
                  className="ui-icon-button ui-icon-button--auto"
                  style={{ width: "100%", justifyContent: "flex-start", gap: 7, padding: "7px 9px", fontSize: 12 }}
                >
                  <Plus size={14} aria-hidden="true" />
                  添加站点
                </button>
              )}


            </div>
          )}

          <div
            data-aihub-composer=""
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: 48,
              padding: "6px 8px",
              borderRadius: 8,
              border: "1px solid var(--border-default)",
              background: "var(--bg-workspace)",
            }}
          >
            <button
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              aria-label="选择 AI 站点"
              title="选择 AI 站点"
              className="ui-icon-button ui-icon-button--auto"
              style={{ height: 34, gap: 5, padding: "0 10px", fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}
            >
              {selectedIds.length} 个 AI
              <ChevronDown size={14} aria-hidden="true" style={{ transform: pickerOpen ? "rotate(180deg)" : undefined }} />
            </button>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void addImages(files);
            }} />
            <button type="button" aria-label="添加图片附件" title="添加图片附件（也可粘贴截图）" disabled={sending || readingImages || images.length >= MAX_RELAY_IMAGES} onClick={() => fileInputRef.current?.click()} className="ui-icon-button" style={{ width: 34, height: 34, padding: 0, flexShrink: 0 }}>
              <Paperclip size={17} aria-hidden="true" />
            </button>
            <textarea
              ref={draftRef}
              aria-label="发送给选中的 AI"
              disabled={sending}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (files.length === 0) return;
                event.preventDefault();
                void addImages(files);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter" && (!event.shiftKey || event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                } else if (event.key === "Escape" && pickerOpen) {
                  event.preventDefault();
                  setPickerOpen(false);
                }
              }}
              rows={1}
              placeholder={`一次输入，发到 ${selectedIds.length} 个选中的 AI（Enter 发送，Shift+Enter 换行）`}
              style={{ flex: 1, minWidth: 0, height: 32, minHeight: 32, maxHeight: 120, boxSizing: "border-box", resize: "none", padding: "4px 2px", border: 0, outline: "none", boxShadow: "none", background: "transparent", color: "var(--text-primary)", fontSize: 13, lineHeight: 1.5, textAlign: draft ? "left" : "center" }}
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={(!draft.trim() && images.length === 0) || sending || readingImages || selectedIds.length === 0}
              title="同步发送（Enter）"
              aria-label="同步发送"
              className="ui-icon-button"
              style={{ width: 36, height: 36, padding: 0, borderRadius: "50%", background: (draft.trim() || images.length > 0) && !sending ? "var(--accent)" : "var(--bg-glass)", color: (draft.trim() || images.length > 0) && !sending ? "var(--bg-workspace)" : "var(--text-muted)", flexShrink: 0 }}
            >
              <Send size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {images.length > 0 && (
          <div aria-label="待发送图片" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {images.map((src, index) => (
              <div key={`${index}-${src.length}`} style={{ position: "relative", width: 56, height: 56 }}>
                <img src={src} alt={`附件 ${index + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 6 }} />
                <button type="button" aria-label={`移除附件 ${index + 1}`} disabled={sending} onClick={() => setImages((current) => current.filter((_, i) => i !== index))} className="ui-icon-button" style={{ position: "absolute", top: 0, right: 0, padding: 2, background: "var(--bg-workspace)" }}><X size={12} /></button>
              </div>
            ))}
          </div>
        )}
        {attachmentError && <div role="alert" style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>{attachmentError}</div>}
        {chips.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", minHeight: 18 }}>
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
                  whiteSpace: "normal",
                  overflowWrap: "anywhere",
                }}
              >
                {(sites.find((candidate) => candidate.id === chip.siteId)?.name ?? chip.siteId)
                + (chip.ok ? " ✓" : ` ✕ ${chip.reason ?? "失败"}`)}
              </span>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

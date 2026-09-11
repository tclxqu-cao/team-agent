"use client";
// AiHubPane — web 控制台的 AI Hub 页签：多站点勾选 + 底部输入台（图片/文本）一次同步发送。
// 注入由服务端转发桌面端中继完成（已登录 WebContentsView），本页不再内嵌 iframe：
//   - 桌面端中继在线：文本 + 图片直接注入已登录页面，回答在桌面端 AI Hub 窗口生成；
//   - 桌面端离线：回退"新标签直达 + 剪贴板接力"（仅文本；图片只能经桌面端注入）。
// 颜色全部引用页面根节点的 --ui-* 主题变量，分割线/输入台随皮肤联动。

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ImagePlus, LoaderCircle, Send, X } from "lucide-react";
import {
  AI_HUB_SELECTION_KEY,
  AI_HUB_SITES,
  buildSiteOpenUrl,
  normalizeSelection,
  siteSupportsPromptUrl,
} from "./aiHubSites";

interface AiHubPaneProps {
  visible: boolean;
  rpc?: <T = unknown>(type: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
}

type SendState = "idle" | "opened" | "blocked" | "injected" | "failed";
type RelayState = "probing" | "online" | "offline";

interface ComposerImage {
  id: string;
  dataUrl: string;
  name: string;
}

interface RelaySendResponse {
  available: boolean;
  reason?: string;
  results?: Array<{ siteId: string; ok: boolean; reason?: string }>;
}

interface RelayCaptureResponse {
  available: boolean;
  results?: Array<{
    siteId: string;
    ok: boolean;
    reason?: string;
    strategy?: string;
    messages?: Array<{ role: string; text: string }>;
    debug?: Record<string, unknown>;
  }>;
}

interface TranscriptMessage {
  role: string;
  text: string;
}

interface CaptureMeta {
  strategy?: string;
  bodyChars?: number;
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.onload = () => resolvePromise(String(reader.result));
    reader.onerror = () => rejectPromise(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export default function AiHubPane({ visible, rpc }: AiHubPaneProps) {
  const [selected, setSelected] = useState<string[]>(() => AI_HUB_SITES.slice(0, 2).map((site) => site.id));
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [sendStates, setSendStates] = useState<Record<string, SendState>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [relay, setRelay] = useState<RelayState>("probing");
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptMessage[]>>({});
  const [captureMeta, setCaptureMeta] = useState<Record<string, CaptureMeta>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 勾选持久化（localStorage 只在客户端可读，挂载后再恢复）+ 桌面端中继探测
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(AI_HUB_SELECTION_KEY);
      if (raw) setSelected(normalizeSelection(JSON.parse(raw)));
    } catch {
      // 坏数据走默认勾选
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!rpc) {
      setRelay("offline");
      return;
    }
    let disposed = false;
    rpc<{ available: boolean }>("aihub:status", undefined, 6000)
      .then((status) => {
        if (!disposed) setRelay(status.available ? "online" : "offline");
      })
      .catch(() => {
        if (!disposed) setRelay("offline");
      });
    return () => {
      disposed = true;
    };
  }, [rpc]);

  const toggleSite = useCallback((id: string) => {
    setSelected((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      if (next.length === 0) return current;
      try {
        window.localStorage.setItem(AI_HUB_SELECTION_KEY, JSON.stringify(next));
      } catch {
        // 隐私模式等场景下存不了就仅内存态
      }
      return next;
    });
  }, []);

  const openSite = useCallback((id: string, text: string) => {
    const url = buildSiteOpenUrl(id, text);
    if (!url) return null;
    const opened = window.open(url, "_blank", "noopener");
    setSendStates((current) => ({ ...current, [id]: opened ? "opened" : "blocked" }));
    return opened != null;
  }, []);

  const addImageFiles = useCallback(async (files: FileList | File[]) => {
    const incoming = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (incoming.length === 0) return;
    const next: ComposerImage[] = [];
    for (const file of incoming) {
      if (images.length + next.length >= MAX_IMAGES) {
        setNotice(`最多同时携带 ${MAX_IMAGES} 张图片`);
        setNoticeError(true);
        break;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setNotice(`图片 ${file.name} 超过 5MB，已跳过`);
        setNoticeError(true);
        continue;
      }
      try {
        const dataUrl = await readImageAsDataUrl(file);
        next.push({ id: `${Date.now()}-${next.length}-${file.name}`, dataUrl, name: file.name });
      } catch {
        setNotice(`图片 ${file.name} 读取失败`);
        setNoticeError(true);
      }
    }
    if (next.length > 0) setImages((current) => [...current, ...next].slice(0, MAX_IMAGES));
  }, [images.length]);

  const onFileInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addImageFiles(event.target.files);
    event.target.value = "";
  }, [addImageFiles]);

  const removeImage = useCallback((id: string) => {
    setImages((current) => current.filter((item) => item.id !== id));
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    const imagePayload = images.map((item) => item.dataUrl);
    if ((!text && imagePayload.length === 0) || selected.length === 0) return;
    // 桌面端中继在线：rpc 转发给桌面 App，由已登录的 WebContentsView 真实注入文本与图片。
    // 注意：这条路径有 await，不能在它之后 window.open（手势会失效）。
    if (relay === "online" && rpc) {
      setSending(true);
      setNotice(`正在发送至 ${selected.length} 个 AI${images.length > 0 ? "（含图片）" : ""}…`);
      setNoticeError(false);
      rpc<RelaySendResponse>("aihub:send", { text, siteIds: selected, images: imagePayload }, 60000)
        .then((response) => {
          if (!response.available) {
            setRelay("offline");
            setNotice(`桌面端中继不可用（${response.reason ?? "unknown"}）。请再点一次发送，将改用浏览器新标签方式。`);
            setNoticeError(true);
            return;
          }
          const next: Record<string, SendState> = {};
          for (const result of response.results ?? []) {
            next[result.siteId] = result.ok ? "injected" : "failed";
          }
          setSendStates((current) => ({ ...current, ...next }));
          const okCount = Object.values(next).filter((state) => state === "injected").length;
          setNotice(okCount === 0 ? "发送失败，请检查桌面端站点连接" : `已发送至 ${okCount}/${selected.length} 个 AI${okCount < selected.length ? "，部分失败" : ""}`);
          setNoticeError(okCount < selected.length);
          if (okCount > 0) {
            setDraft("");
            setImages([]);
          }
        })
        .catch(() => {
          setRelay("offline");
          setNotice("桌面端中继请求失败。请再点一次发送，将改用浏览器新标签方式。");
          setNoticeError(true);
        })
        .finally(() => setSending(false));
      return;
    }
    // 浏览器直发（回退）：图片无法经剪贴板接力到多个站点，带图发送必须走桌面端中继。
    if (imagePayload.length > 0) {
      setNotice("桌面端中继离线：图片只能经桌面端注入已登录页面，请启动桌面端后再发送。");
      setNoticeError(true);
      return;
    }
    // 先同步开新标签 —— window.open 必须发生在用户手势的同步调用栈内，
    // 一旦先 await（如写剪贴板）手势即失效，Safari 会拦截。
    const nextStates: Record<string, SendState> = {};
    for (const id of selected) {
      const url = buildSiteOpenUrl(id, text);
      if (!url) continue;
      const opened = window.open(url, "_blank", "noopener");
      nextStates[id] = opened ? "opened" : "blocked";
    }
    setSendStates((current) => ({ ...current, ...nextStates }));
    // 后复制剪贴板（DeepSeek/Gemini 无 ?q=，靠粘贴接力）
    void copyText(text).then((copied) => {
      const blocked = selected.filter((id) => nextStates[id] === "blocked");
      const directCount = selected.filter(siteSupportsPromptUrl).length;
      if (blocked.length > 0) {
        setNotice(`已复制问题；${blocked.map((id) => AI_HUB_SITES.find((s) => s.id === id)?.name ?? id).join("、")}的标签被浏览器拦截，请点对应分屏里的"打开"按钮（单次点击不会被拦）。`);
        setNoticeError(true);
        return;
      }
      setNotice(
        copied && directCount < selected.length
          ? `已打开 ${selected.length} 个站点并复制问题；打勾站点的输入框会自动带上问题并发送，其余站点请粘贴（⌘V）。`
          : `已打开 ${selected.length} 个站点。`,
      );
      setNoticeError(false);
    });
  }, [draft, images, selected, relay, rpc]);

  const columns = useMemo(() => Math.min(Math.max(selected.length, 1), 4), [selected]);

  // 桌面端会话回灌：中继在线且页签可见时轮询 capture，把已注入站点的对话同步到分屏
  useEffect(() => {
    if (relay !== "online" || !rpc || !visible || selected.length === 0) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = () => {
      rpc<RelayCaptureResponse>("aihub:capture", { siteIds: selected }, 12000)
        .then((response) => {
          if (disposed || !response.available) return;
          const next: Record<string, TranscriptMessage[]> = {};
          const nextMeta: Record<string, CaptureMeta> = {};
          for (const result of response.results ?? []) {
            if (result.ok && result.messages && result.messages.length > 0) {
              next[result.siteId] = result.messages;
            }
            if (result.ok) {
              nextMeta[result.siteId] = {
                strategy: result.strategy,
                bodyChars: typeof result.debug?.bodyChars === "number" ? result.debug.bodyChars : undefined,
              };
            }
          }
          setTranscripts((current) => ({ ...current, ...next }));
          setCaptureMeta((current) => ({ ...current, ...nextMeta }));
        })
        .catch(() => {})
        .finally(() => {
          if (!disposed) timer = window.setTimeout(poll, 4000);
        });
    };
    poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [relay, rpc, visible, selected]);

  if (!hydrated) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--ui-root-bg)",
        color: "var(--ui-text)",
        minHeight: 0,
      }}
    >
      {/* 等宽分屏：格子只做站点状态台，注入在桌面端完成 */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: 1,
          background: "var(--ui-muted-border)",
        }}
      >
        {selected.map((id) => {
          const site = AI_HUB_SITES.find((candidate) => candidate.id === id);
          if (!site) return null;
          const state = sendStates[id] ?? "idle";
          const stateText = state === "opened"
            ? "已在新标签打开"
            : state === "blocked"
              ? "标签被拦截"
              : state === "injected"
                ? "已注入 · 回答在桌面端生成"
                : state === "failed"
                  ? "注入失败"
                  : "等待发送";
          return (
            <div
              key={id}
              data-aihub-pane={id}
              style={{ display: "flex", flexDirection: "column", background: "var(--ui-root-bg)", minWidth: 0 }}
            >
              <div
                style={{
                  height: 34,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 8px",
                  borderBottom: "1px solid var(--ui-muted-border)",
                  background: "var(--ui-tabbar-bg)",
                  fontSize: 12,
                  color: "var(--ui-tab-text)",
                }}
              >
                <strong style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ui-text)" }}>{site.name}</strong>
                <button
                  type="button"
                  onClick={() => openSite(id, draft)}
                  title={siteSupportsPromptUrl(id) ? "带问题打开" : "打开首页（问题在剪贴板）"}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--ui-muted-border)",
                    background: "var(--ui-panel-input-bg)",
                    color: "var(--ui-tab-accent)",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  打开
                </button>
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  padding: 12,
                  overflow: "hidden",
                }}
              >
                {(transcripts[id]?.length ?? 0) > 0 ? (
                  <PaneTranscript messages={transcripts[id]} />
                ) : (
                  <>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 44,
                        height: 44,
                        display: "grid",
                        placeItems: "center",
                        borderRadius: 12,
                        background: "var(--ui-muted-surface)",
                        border: "1px solid var(--ui-muted-border)",
                        color: "var(--ui-tab-accent)",
                        fontSize: 18,
                        fontWeight: 600,
                      }}
                    >
                      {site.name.slice(0, 1)}
                    </span>
                    <span
                      data-aihub-pane-state={state}
                      style={{
                        fontSize: 12,
                        textAlign: "center",
                        color: state === "injected" || state === "opened"
                          ? "var(--ui-success)"
                          : state === "failed" || state === "blocked"
                            ? "var(--ui-error)"
                            : "var(--ui-muted-text)",
                      }}
                    >
                      {stateText}
                    </span>
                    {captureMeta[id]?.strategy === "none" && (
                      <span style={{ fontSize: 11, textAlign: "center", color: "var(--ui-muted-text)", maxWidth: 200 }}>
                        站点未登录或页面未就绪：请在桌面端 AI Hub 窗口内打开并登录该站点，登录态会持久保留
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 底部输入台：模型选择收进输入框下拉（多选），图片 + 文本，风格对齐 webapp 输入框 */}
      <div
        style={{
          borderTop: "1px solid var(--ui-muted-border)",
          background: "var(--ui-tabbar-bg)",
          padding: "8px 12px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div role="status" style={{ minWidth: 0, fontSize: 11, color: noticeError && notice ? "var(--ui-error)" : relay === "online" ? "var(--ui-success)" : "var(--ui-muted-text)", display: "flex", alignItems: "center", gap: 8 }}>
          <span title={notice || (relay === "online" ? "通过电脑上已登录的 AI 页面发送和同步回复" : "连接桌面端后可同步回复")} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {notice || (relay === "online" ? "● 桌面端已连接" : relay === "probing" ? "正在连接桌面端…" : "桌面端未连接 · 发送将打开网页")}
          </span>
          {notice && <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示" style={{ flexShrink: 0, background: "none", border: 0, color: "var(--ui-muted-text)", cursor: "pointer", display: "grid", placeItems: "center" }}>
            <X size={12} aria-hidden="true" />
          </button>}
        </div>

        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderRadius: 14,
            border: "1px solid var(--ui-panel-input-border)",
            background: "var(--ui-panel-input-bg)",
            padding: "6px 8px",
          }}
        >
          {pickerOpen && (
            <>
              <div
                aria-hidden="true"
                onClick={() => setPickerOpen(false)}
                style={{ position: "fixed", inset: 0, zIndex: 30 }}
              />
              <div
                role="listbox"
                aria-label="选择要发送的 AI 站点"
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 8px)",
                  left: 0,
                  zIndex: 31,
                  minWidth: 210,
                  background: "var(--ui-panel-input-bg)",
                  border: "1px solid var(--ui-muted-border)",
                  borderRadius: 12,
                  boxShadow: "0 8px 24px rgba(0,0,0,.14)",
                  padding: 4,
                  maxHeight: 260,
                  overflowY: "auto",
                }}
              >
                {AI_HUB_SITES.map((site) => {
                  const active = selected.includes(site.id);
                  return (
                    <button
                      key={site.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => toggleSite(site.id)}
                      style={{
                        display: "flex",
                        width: "100%",
                        alignItems: "center",
                        gap: 8,
                        padding: "8px 10px",
                        border: 0,
                        borderRadius: 8,
                        background: active ? "var(--ui-muted-surface)" : "transparent",
                        color: "var(--ui-text)",
                        fontSize: 13,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 18,
                          height: 18,
                          display: "grid",
                          placeItems: "center",
                          borderRadius: "50%",
                          border: `1px solid ${active ? "var(--ui-tab-accent)" : "var(--ui-muted-border)"}`,
                          background: active ? "var(--ui-tab-accent)" : "transparent",
                          color: "#ffffff",
                          fontSize: 11,
                          flexShrink: 0,
                        }}
                      >
                        {active ? "✓" : ""}
                      </span>
                      {site.name}
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ui-muted-text)" }}>
                        {siteSupportsPromptUrl(site.id) ? "自动发送" : "粘贴发送"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            aria-label="选择 AI 站点"
            title="选择 AI 站点"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              height: 32,
              padding: "0 10px",
              borderRadius: 999,
              border: `1px solid ${pickerOpen ? "var(--ui-tab-accent)" : "var(--ui-muted-border)"}`,
              background: pickerOpen ? "var(--ui-muted-surface)" : "transparent",
              color: "var(--ui-tab-accent)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {selected.length} 个 AI
            <ChevronDown
              size={14}
              aria-hidden="true"
              style={{ transform: pickerOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}
            />
          </button>

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {images.map((image) => (
                  <span
                    key={image.id}
                    style={{
                      position: "relative",
                      width: 44,
                      height: 44,
                      borderRadius: 8,
                      overflow: "hidden",
                      border: "1px solid var(--ui-muted-border)",
                      display: "block",
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.dataUrl} alt={image.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                    <button
                      type="button"
                      onClick={() => removeImage(image.id)}
                      aria-label={`移除图片 ${image.name}`}
                      style={{
                        position: "absolute",
                        top: 1,
                        right: 1,
                        width: 16,
                        height: 16,
                        display: "grid",
                        placeItems: "center",
                        borderRadius: "50%",
                        border: 0,
                        background: "rgba(0,0,0,.6)",
                        color: "#fff",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  send();
                } else if (event.key === "Escape" && pickerOpen) {
                  event.preventDefault();
                  setPickerOpen(false);
                }
              }}
              rows={1}
              placeholder={`一次输入，发到 ${selected.length} 个选中的 AI（⌘⏎ 发送）`}
              style={{
                resize: "none",
                border: 0,
                outline: "none",
                background: "transparent",
                color: "var(--ui-panel-input-text)",
                // iOS Safari：聚焦时字号 <16px 会自动放大页面，16px 是免放大阈值
                fontSize: 16,
                lineHeight: "20px",
                maxHeight: 60,
                padding: 0,
                width: "100%",
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="添加图片"
            title={`添加图片（最多 ${MAX_IMAGES} 张）`}
            disabled={images.length >= MAX_IMAGES}
            style={{
              display: "grid",
              placeItems: "center",
              width: 32,
              height: 32,
              borderRadius: "50%",
              border: "1px solid var(--ui-muted-border)",
              background: "transparent",
              color: images.length >= MAX_IMAGES ? "var(--ui-muted-text)" : "var(--ui-tab-accent)",
              cursor: images.length >= MAX_IMAGES ? "default" : "pointer",
              flexShrink: 0,
            }}
          >
            <ImagePlus size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={send}
            aria-label="同步发送"
            disabled={sending || selected.length === 0 || (!draft.trim() && images.length === 0)}
            title="同步发送（⌘⏎）"
            style={{
              display: "grid",
              placeItems: "center",
              width: 34,
              height: 34,
              borderRadius: "50%",
              border: 0,
              background: sending || selected.length === 0 || (!draft.trim() && images.length === 0)
                ? "var(--ui-muted-surface)"
                : "var(--ui-tab-accent)",
              color: sending || selected.length === 0 || (!draft.trim() && images.length === 0)
                ? "var(--ui-muted-text)"
                : "#ffffff",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {sending ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onFileInputChange}
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}

// 分屏内的会话气泡：桌面端抽取的对话按序渲染，新消息始终滚到底部
function PaneTranscript({ messages }: { messages: TranscriptMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const signature = messages.map((item) => `${item.role}:${item.text.length}`).join("|");
  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [signature]);
  return (
    <div
      ref={scrollRef}
      data-aihub-transcript=""
      style={{
        width: "100%",
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "4px 2px 8px",
      }}
    >
      {messages.map((message, index) => {
        const isUser = message.role === "user";
        return (
          <div
            key={index}
            data-aihub-msg-role={message.role}
            style={{
              maxWidth: "92%",
              alignSelf: isUser ? "flex-end" : "flex-start",
              background: isUser ? "var(--ui-tab-accent)" : "var(--ui-muted-surface)",
              color: isUser ? "#ffffff" : "var(--ui-text)",
              borderRadius: 12,
              borderBottomRightRadius: isUser ? 4 : 12,
              borderBottomLeftRadius: isUser ? 12 : 4,
              padding: "6px 9px",
              fontSize: 12,
              lineHeight: "17px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {message.text}
          </div>
        );
      })}
    </div>
  );
}

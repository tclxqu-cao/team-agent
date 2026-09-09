import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, LoaderCircle, MonitorUp, MousePointer2, RotateCcw, X } from "lucide-react";
import type { BrowserLiveSession } from "../global";

interface BrowserFrame {
  sessionId: string;
  sequence: number;
  data: string | ArrayBuffer;
  mime: "image/jpeg";
  viewport?: BrowserLiveSession["viewport"];
  title?: string;
  url?: string;
  timestamp: number;
}

interface BrowserLivePanelProps {
  open: boolean;
  agentSessionId?: string | null;
  onClose: () => void;
}

const STATE_LABELS: Record<BrowserLiveSession["state"], string> = {
  "agent-controlled": "Agent 操作中",
  "handoff-requested": "正在交接",
  "user-controlled": "你正在操作",
  "return-requested": "正在归还",
  resyncing: "Agent 正在同步页面",
};

function backendLabel(backend: BrowserLiveSession["backend"]): string {
  if (backend === "desktop") return "桌面屏幕";
  return backend === "ego-browser" ? "ego-browser" : "内置 Browser";
}

export function selectBrowserLiveSessionId(
  current: string | null,
  sessions: BrowserLiveSession[],
  agentSessionId?: string,
): string | null {
  if (current) return current;
  return sessions.find((session) => session.agentSessionId === agentSessionId)?.id
    ?? sessions[0]?.id
    ?? null;
}

function modifierNames(event: React.KeyboardEvent): string[] {
  return [
    event.altKey ? "Alt" : "",
    event.ctrlKey ? "Control" : "",
    event.metaKey ? "Meta" : "",
    event.shiftKey ? "Shift" : "",
  ].filter(Boolean);
}

export default function BrowserLivePanel({ open, agentSessionId, onClose }: BrowserLivePanelProps) {
  const api = typeof window === "undefined" ? undefined : window.browserLiveApi;
  const [sessions, setSessions] = useState<BrowserLiveSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const pointerDown = useRef(false);
  const textInputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [selectedId, sessions],
  );
  const frameSrc = useMemo(() => {
    if (!frame) return null;
    if (typeof frame.data === "string") return `data:${frame.mime};base64,${frame.data}`;
    return URL.createObjectURL(new Blob([frame.data], { type: frame.mime }));
  }, [frame]);
  useEffect(() => () => {
    if (frameSrc?.startsWith("blob:")) URL.revokeObjectURL(frameSrc);
  }, [frameSrc]);

  const mergeSession = useCallback((session: BrowserLiveSession) => {
    setSessions((current) => {
      const index = current.findIndex((item) => item.id === session.id);
      if (index < 0) return [session, ...current];
      const next = [...current];
      next[index] = session;
      return next.sort((left, right) => right.updatedAt - left.updatedAt);
    });
    setSelectedId((current) => selectBrowserLiveSessionId(current, [session], agentSessionId));
    setControlPending(false);
  }, [agentSessionId]);

  const refresh = useCallback(async () => {
    if (!api || !open) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.request<{ sessions: BrowserLiveSession[] }>("browser:list");
      setSessions(result.sessions);
      setSelectedId((current) => {
        const validCurrent = current && result.sessions.some((session) => session.id === current)
          ? current
          : null;
        return selectBrowserLiveSessionId(validCurrent, result.sessions, agentSessionId);
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法读取浏览器会话");
    } finally {
      setLoading(false);
    }
  }, [agentSessionId, api, open]);

  useEffect(() => {
    if (!open || !api) return;
    void refresh();
    return api.onEvent((event) => {
      if (event.type === "browser:frame") {
        const nextFrame = event as unknown as BrowserFrame & { type: string };
        if (nextFrame.sessionId === selectedId) setFrame(nextFrame);
        return;
      }
      if (event.session && typeof event.session === "object") {
        mergeSession(event.session as BrowserLiveSession);
      }
      if (event.type === "browser:closed") {
        const closed = event.session as BrowserLiveSession | undefined;
        if (closed) {
          setSessions((current) => current.filter((session) => session.id !== closed.id));
          if (closed.id === selectedId) {
            setFrame(null);
            setSelectedId(null);
          }
        }
      }
    });
  }, [api, mergeSession, open, refresh, selectedId]);

  useEffect(() => {
    if (!open || !api || !selectedId) return;
    setFrame(null);
    setError(null);
    void api.request<{ session: BrowserLiveSession }>("browser:watch", { sessionId: selectedId })
      .then((result) => mergeSession(result.session))
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "无法观看浏览器"));
    return () => { void api.request("browser:unwatch").catch(() => undefined); };
  }, [api, mergeSession, open, selectedId]);

  const requestControl = useCallback(async () => {
    if (!api || !selected) return;
    setControlPending(true);
    setError(null);
    try {
      const result = await api.request<{ session: BrowserLiveSession }>("browser:takeover", { sessionId: selected.id });
      mergeSession(result.session);
    } catch (requestError) {
      setControlPending(false);
      setError(requestError instanceof Error ? requestError.message : "无法接管浏览器");
    }
  }, [api, mergeSession, selected]);

  const returnControl = useCallback(async () => {
    if (!api || !selected) return;
    setControlPending(true);
    setError(null);
    try {
      const result = await api.request<{ session: BrowserLiveSession }>("browser:return", { sessionId: selected.id });
      mergeSession(result.session);
    } catch (requestError) {
      setControlPending(false);
      setError(requestError instanceof Error ? requestError.message : "无法归还浏览器");
    }
  }, [api, mergeSession, selected]);

  const sendInput = useCallback((input: Record<string, unknown>) => {
    if (!api || !selected?.isController || selected.state !== "user-controlled") return;
    void api.request("browser:input", { sessionId: selected.id, input }).catch((requestError) => {
      setError(requestError instanceof Error ? requestError.message : "浏览器输入失败");
    });
  }, [api, selected]);

  const pointerCoordinates = useCallback((event: React.PointerEvent<HTMLElement> | React.WheelEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewport = frame?.viewport ?? selected?.viewport;
    if (!viewport) return null;
    const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
    const contentWidth = viewport.width * scale;
    const contentHeight = viewport.height * scale;
    const offsetX = (rect.width - contentWidth) / 2;
    const offsetY = (rect.height - contentHeight) / 2;
    const x = (event.clientX - rect.left - offsetX) / contentWidth;
    const y = (event.clientY - rect.top - offsetY) / contentHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }, [frame?.viewport, selected?.viewport]);

  if (!open || typeof document === "undefined") return null;

  const controllable = selected?.online && !selected.controlledByAnotherViewer;
  const hasControl = selected?.isController && selected.state === "user-controlled";
  const isDesktop = selected?.backend === "desktop";
  const statusLabel = selected?.availability === "unavailable"
    ? (isDesktop ? "桌面直播不可用" : "浏览器直播不可用")
    : selected?.availability === "starting"
      ? (isDesktop ? "正在连接画面" : "正在连接画面")
      : isDesktop && selected?.state === "agent-controlled"
        ? "未被远程控制"
        : selected
          ? STATE_LABELS[selected.state]
          : isDesktop
            ? "等待桌面直播"
            : "等待浏览器";
  const emptyTitle = selected?.availability === "unavailable"
    ? (isDesktop ? "桌面直播不可用" : "浏览器直播不可用")
    : selected?.availability === "starting"
      ? "正在连接画面"
      : sessions.length
        ? "等待第一帧"
        : isDesktop
          ? "暂无桌面直播"
          : "暂无浏览器直播";
  const emptyDetail = selected?.availability === "unavailable"
    ? selected.capabilityError || (isDesktop ? "需要在桌面 App 中开启并授予屏幕录制权限" : "当前浏览器不支持实时画面传输")
    : sessions.length
      ? "画面开始后会自动显示"
      : isDesktop
        ? "在桌面 App 设置中开启「桌面直播与远程控制」后，画面会出现在这里"
        : "Agent 开始浏览网页后，会话会出现在这里";

  return createPortal(
    <div className="browser-live-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={`browser-live-panel ${sessions.length > 1 ? "has-session-tabs" : ""}`} role="dialog" aria-modal="true" aria-label="浏览器直播">
        <header className="browser-live-header">
          <div className="browser-live-heading">
            <MonitorUp size={17} aria-hidden="true" />
            <div>
              <strong>浏览器直播</strong>
              <span>{selected ? backendLabel(selected.backend) : "实时观看与接管"}</span>
            </div>
          </div>
          <div className="browser-live-header-actions">
            <button type="button" className="ui-icon-button" onClick={() => void refresh()} title="刷新会话" aria-label="刷新浏览器会话">
              <RotateCcw size={15} aria-hidden="true" />
            </button>
            <button type="button" className="ui-icon-button" onClick={onClose} title="关闭" aria-label="关闭浏览器直播">
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        {sessions.length > 1 && (
          <div className="browser-live-session-tabs" role="tablist" aria-label="浏览器会话">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                role="tab"
                aria-selected={session.id === selectedId}
                className={session.id === selectedId ? "is-active" : ""}
                onClick={() => setSelectedId(session.id)}
              >
                <span>{backendLabel(session.backend)}</span>
                <small>{session.title || "浏览器"}</small>
              </button>
            ))}
          </div>
        )}

        <div className={`browser-live-surface ${hasControl ? "is-controlling" : ""}`}>
          {frame && frameSrc ? (
            <div
              className="browser-live-image-hit-area"
              tabIndex={hasControl ? 0 : -1}
              onPointerDown={(event) => {
                if (!hasControl) return;
                const point = pointerCoordinates(event);
                if (!point) return;
                pointerDown.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                textInputRef.current?.focus({ preventScroll: true });
                sendInput({ kind: "pointer", action: "down", ...point, button: "left" });
              }}
              onPointerMove={(event) => {
                if (!hasControl || !pointerDown.current) return;
                const point = pointerCoordinates(event);
                if (point) sendInput({ kind: "pointer", action: "move", ...point, button: "left" });
              }}
              onPointerUp={(event) => {
                if (!hasControl) return;
                const point = pointerCoordinates(event);
                pointerDown.current = false;
                if (point) sendInput({ kind: "pointer", action: "up", ...point, button: "left" });
              }}
              onWheel={(event) => {
                if (!hasControl) return;
                const point = pointerCoordinates(event);
                if (point) sendInput({ kind: "pointer", action: "wheel", ...point, deltaX: event.deltaX, deltaY: event.deltaY });
              }}
              onKeyDown={(event) => {
                if (!hasControl) return;
                sendInput({ kind: "key", action: "down", key: event.key, code: event.code, text: event.key.length === 1 ? event.key : "", modifiers: modifierNames(event) });
                if (["Backspace", "Tab", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Escape"].includes(event.key)) event.preventDefault();
              }}
              onKeyUp={(event) => {
                if (hasControl) sendInput({ kind: "key", action: "up", key: event.key, code: event.code, modifiers: modifierNames(event) });
              }}
            >
              <img src={frameSrc} alt={selected?.title || "浏览器实时画面"} draggable={false} />
              <input
                ref={textInputRef}
                className="browser-live-mobile-input"
                aria-label="浏览器键盘输入"
                value=""
                onChange={(event) => {
                  if (event.target.value) sendInput({ kind: "key", action: "down", text: event.target.value, key: "", code: "", modifiers: [] });
                }}
              />
            </div>
          ) : (
            <div className="browser-live-empty">
              {(loading || selected?.availability === "starting") ? <LoaderCircle size={22} className="spin" aria-hidden="true" /> : <MonitorUp size={24} aria-hidden="true" />}
              <strong>{loading ? "正在连接浏览器" : emptyTitle}</strong>
              <span>{emptyDetail}</span>
            </div>
          )}
          {hasControl && (
            <div className="browser-live-control-cue"><MousePointer2 size={13} aria-hidden="true" /> {isDesktop ? "当前输入会发送到本机" : "当前输入会发送到浏览器"}</div>
          )}
        </div>

        <footer className="browser-live-footer">
          <div className="browser-live-location">
            <span className={`browser-live-status-dot is-${selected?.state ?? "idle"}`} aria-hidden="true" />
            <div>
              <strong>{statusLabel}</strong>
              <span title={selected?.url}>{selected?.capabilityError || (isDesktop ? "本机屏幕" : selected?.url) || error || "等待可观看的直播会话"}</span>
            </div>
            {selected?.url && !isDesktop && <ExternalLink size={13} aria-hidden="true" />}
          </div>
          {selected && (hasControl ? (
            <button type="button" className="browser-live-control-button is-return" onClick={() => void returnControl()} disabled={controlPending}>
              {controlPending && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
              {isDesktop ? "结束控制" : "归还给 Agent"}
            </button>
          ) : (
            <button type="button" className="browser-live-control-button" onClick={() => void requestControl()} disabled={!controllable || controlPending || selected.state !== "agent-controlled" || selected.availability !== "ready"}>
              {controlPending && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
              {selected.controlledByAnotherViewer ? "其他设备操作中" : isDesktop ? "开始控制" : "接管浏览器"}
            </button>
          ))}
        </footer>
        {error && <div className="browser-live-error" role="alert">{error}</div>}
      </section>
    </div>,
    document.body,
  );
}

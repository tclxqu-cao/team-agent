import LiveViewSelect from "./LiveViewSelect";
import { BrowserLiveHeaderContext } from "./browser-live-header-context";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { ExternalLink, Hand, Keyboard, LoaderCircle, Lock, LockOpen, MonitorUp, Maximize, Minimize, MousePointer2, Power, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import type { BrowserLiveSession } from "../global";

import { BrowserLiveTouch } from "./browser-live-touch";

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

/** A tapped text field on the remote screen, in logical screen coordinates. */
export interface RemoteEditableField {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TOUCH_SCROLL_MIN_PX = 2;

/** Whether a viewport-fraction point lands inside (or near) a remembered region. */
export function remoteFieldContains(
  field: RemoteEditableField | null,
  viewport: { width: number; height: number } | null | undefined,
  x: number,
  y: number,
  pad = 0.02,
): boolean {
  if (!field || !viewport || !viewport.width || !viewport.height) return false;
  const left = field.x / viewport.width - pad;
  const top = field.y / viewport.height - pad;
  const right = (field.x + field.w) / viewport.width + pad;
  const bottom = (field.y + field.h) / viewport.height + pad;
  return x >= left && x <= right && y >= top && y <= bottom;
}

/** Maps a two-finger drag to a remote wheel delta. Swiping up (to.y < from.y)
 *  scrolls the remote content down, matching how a phone page scrolls. */
export function touchScrollDelta(
  from: { x: number; y: number },
  to: { x: number; y: number },
  min = TOUCH_SCROLL_MIN_PX,
): { deltaX: number; deltaY: number } | null {
  const delta = { deltaX: Math.round(from.x - to.x), deltaY: Math.round(from.y - to.y) };
  if (Math.abs(delta.deltaX) < min && Math.abs(delta.deltaY) < min) return null;
  return delta;
}

export default function BrowserLivePanel({ open, agentSessionId, onClose }: BrowserLivePanelProps) {
  const headerControl = useContext(BrowserLiveHeaderContext);
  const api = typeof window === "undefined" ? undefined : window.browserLiveApi;
  const panelRef = useRef<HTMLElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const toggleFullscreen = async () => {
    const panel = panelRef.current;
    if (!panel) return;
    if (fullscreen) {
      if (document.fullscreenElement === panel) await document.exitFullscreen().catch(() => undefined);
      setFullscreen(false);
      return;
    }
    // iPhone Safari and embedded webviews may only support in-page fullscreen.
    setFullscreen(true);
    if (panel.requestFullscreen) await panel.requestFullscreen().catch(() => undefined);
  };
  useEffect(() => {
    if (!open) { setFullscreen(false); return; }
    const panel = panelRef.current;
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === panel);
    const escapeFullscreen = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (document.fullscreenElement === panel || panel?.classList.contains("is-fullscreen"))) {
        event.preventDefault();
        event.stopPropagation();
        if (document.fullscreenElement === panel) void document.exitFullscreen().catch(() => undefined);
        setFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("keydown", escapeFullscreen, true);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("keydown", escapeFullscreen, true);
      if (panel && document.fullscreenElement === panel) void document.exitFullscreen().catch(() => undefined);
    };
  }, [open]);
  const [sessions, setSessions] = useState<BrowserLiveSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDisplayId, setPendingDisplayId] = useState<string | null>(null);
  const [videoQuality, setVideoQuality] = useState("hd");
  const [pendingQuality, setPendingQuality] = useState(false);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped by refresh() to force the watch + WebRTC effects to tear down and
  // re-establish, so a frozen picture recovers without closing the panel.
  const [viewNonce, setViewNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [systemBusy, setSystemBusy] = useState<null | "lock" | "wake" | "unlock">(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockPending, setUnlockPending] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panMode, setPanMode] = useState(false);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const pointerDown = useRef(false);
  // A swipe keeps routing its wheel events to the window under where the
  // gesture BEGAN, even as the finger travels across other windows.
  const touchGesturePoint = useRef<{ x: number; y: number } | null>(null);
  const touch = useRef(new BrowserLiveTouch());
  const zoomRef = useRef(zoom);
  const zoomAnchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  useLayoutEffect(() => {
    zoomRef.current = zoom;
    const anchor = zoomAnchor.current;
    const element = viewportRef.current;
    const image = element?.querySelector<HTMLElement>(".browser-live-image-hit-area");
    if (!anchor || !element || !image) return;
    const rect = image.getBoundingClientRect();
    element.scrollLeft += rect.left + anchor.x * rect.width - anchor.clientX;
    element.scrollTop += rect.top + anchor.y * rect.height - anchor.clientY;
    zoomAnchor.current = null;
  }, [zoom]);
  const textInputRef = useRef<HTMLInputElement>(null);
  const [imeOn, setImeOn] = useState(false);
  const imeOnRef = useRef(false);
  // Last tap the desktop hit-test marked as a text field (logical screen coords).
  const editableField = useRef<RemoteEditableField | null>(null);
  const editableAtRef = useRef(0);
  useEffect(() => {
    if (open) return;
    setUnlockOpen(false);
    setUnlockPassword("");
    setUnlockError(null);
  }, [open]);
  const [fieldHint, setFieldHint] = useState(false);
  // Long-press (drag / right-click) and double-tap tracking for touch.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchDownAtRef = useRef(0);
  const longPressRef = useRef<"none" | "armed" | "drag">("none");
  const longPressTimer = useRef<number | null>(null);
  const lastTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [quickKeysOpen, setQuickKeysOpen] = useState(false);
  const wakeLockRef = useRef<{ release(): Promise<void> } | null>(null);
  // Last tap the hit-test marked as an interactive control (button, dock…).
  // Re-tapping a known control skips the optimistic keyboard raise entirely —
  // no flash. First tap on an unseen control still flashes briefly (iOS only
  // allows focus() inside the gesture; the hit-test comes back later).
  const controlFieldRef = useRef<{ rect: RemoteEditableField; at: number } | null>(null);
  // Real-time WebRTC video (desktop source); JPEG frames remain the fallback.
  const [webrtcState, setWebrtcState] = useState<"off" | "connecting" | "live" | "failed">("off");
  const webrtcPeerRef = useRef<RTCPeerConnection | null>(null);
  const webrtcVideoRef = useRef<HTMLVideoElement>(null);
  useLayoutEffect(() => {
    imeOnRef.current = imeOn;
    if (imeOn) setFieldHint(false);
  }, [imeOn]);



  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [selectedId, sessions],
  );
  const isDesktop = selected?.backend === "desktop";
  const isWindowsDesktop = isDesktop && selected?.platform === "win32";
  const desktopLocked = selected?.availability === "unavailable" && selected?.capabilityErrorCode === "desktop-locked";
  const hasControl = selected?.isController && selected.state === "user-controlled";
  const canAdjustCapture = Boolean(selected?.online && selected.availability === "ready" && !selected.controlledByAnotherViewer);
  // Rough network latency readout while a stream is open.
  useEffect(() => {
    if (!open || !api || !selectedId) { setPingMs(null); return; }
    let alive = true;
    const tick = () => {
      const t0 = performance.now();
      void api.request("browser:ping", { t: t0 }).then(() => {
        if (alive) setPingMs(Math.round(performance.now() - t0));
      }).catch(() => { if (alive) setPingMs(null); });
    };
    tick();
    const timer = window.setInterval(tick, 3000);
    return () => { alive = false; window.clearInterval(timer); setPingMs(null); };
  }, [api, open, selectedId]);

  // Keep the phone screen awake while controlling (ToDesk-style).
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
    if (!hasControl || !nav.wakeLock) return;
    let cancelled = false;
    let lock: { release(): Promise<void> } | null = null;
    void nav.wakeLock.request("screen").then((acquired) => {
      if (cancelled) { void acquired.release(); return; }
      lock = acquired;
      wakeLockRef.current = acquired;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      void lock?.release().catch(() => undefined);
      wakeLockRef.current = null;
    };
  }, [hasControl]);
  const viewport = frame?.viewport ?? selected?.viewport;
  const fitScale = viewport && surfaceSize.width && surfaceSize.height
    ? Math.min(surfaceSize.width / viewport.width, surfaceSize.height / viewport.height)
    : null;

  useEffect(() => {
    setZoom(1);
    setPanMode(false);
    panStart.current = null;
    touch.current.reset();
    zoomAnchor.current = null;
    editableField.current = null;
    controlFieldRef.current = null;
    viewportRef.current?.scrollTo(0, 0);
  }, [open, selectedId]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!open || !element) return;
    const observer = new ResizeObserver(() => {
      setSurfaceSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, isDesktop]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!open || !element || !hasControl || panMode) return;
    // React wheel listeners are passive; cancel local scrolling while controlling remotely.
    const preventLocalScroll = (event: WheelEvent) => event.preventDefault();
    element.addEventListener("wheel", preventLocalScroll, { passive: false });
    return () => element.removeEventListener("wheel", preventLocalScroll);
  }, [open, hasControl, panMode]);

  // The soft keyboard only summons from a real user gesture (click), so the
  // toolbar keyboard button owns it; drop the IME when control or pan changes.
  const toggleIme = useCallback(() => {
    const input = textInputRef.current;
    if (!input) return;
    if (imeOn) {
      input.blur();
      setImeOn(false);
    } else {
      input.focus({ preventScroll: true });
      setImeOn(true);
    }
  }, [imeOn]);
  useEffect(() => {
    if ((!hasControl || panMode) && imeOn) {
      textInputRef.current?.blur();
      setImeOn(false);
    }
  }, [hasControl, panMode, imeOn]);

  const scrollRemoteFieldIntoView = useCallback((field: RemoteEditableField | null) => {
    const viewport = frame?.viewport ?? selected?.viewport;
    const element = viewportRef.current;
    const image = element?.querySelector<HTMLElement>(".browser-live-image-hit-area");
    if (!field || !viewport || !element || !image) return;
    const rect = image.getBoundingClientRect();
    const host = element.getBoundingClientRect();
    const top = rect.top + (field.y / viewport.height) * rect.height;
    const bottom = top + (field.h / viewport.height) * rect.height;
    const pad = 16;
    if (top >= host.top + pad && bottom <= host.bottom - pad) return;
    // Park the field in the top third so the phone keyboard (which overlays
    // the bottom of the shrunken viewport) cannot cover it.
    element.scrollTop += top - (host.top + Math.max(pad, host.height * 0.3));
  }, [frame?.viewport, selected?.viewport]);
  // The keyboard animates the visual viewport over several frames; re-anchor
  // the remembered field once it (and the panel resize it causes) settles.
  useEffect(() => {
    if (!imeOn || !editableField.current) return;
    const timer = window.setTimeout(() => scrollRemoteFieldIntoView(editableField.current), 420);
    return () => window.clearTimeout(timer);
  }, [imeOn, surfaceSize.width, surfaceSize.height, scrollRemoteFieldIntoView]);

  const applyHitTest = useCallback((result: Record<string, unknown> | null) => {
    // The relay wraps the helper reply as { input: … }; unwrap when present.
    const payload = result && typeof result.input === "object" && result.input !== null
      ? result.input as Record<string, unknown>
      : result;
    if (typeof payload?.editable !== "boolean") return; // backend without hit-test: keep state
    // The tap optimistically raised the keyboard inside the gesture (iOS
    // requirement). When the hit-test says the finger landed on an interactive
    // control (close button, menu…), lower it again — end state: no keyboard.
    if (!payload.editable && payload.kind === "control") {
      const bounds = payload.bounds as Record<string, unknown> | undefined;
      if (bounds && ["x", "y", "w", "h"].every((key) => typeof bounds[key] === "number")) {
        controlFieldRef.current = {
          rect: { x: bounds.x as number, y: bounds.y as number, w: bounds.w as number, h: bounds.h as number },
          at: Date.now(),
        };
      }
      return;
    }
    if (payload.editable) {
      // Text field tapped: remember it — the next tap raises the keyboard
      // inside the gesture (iOS requirement), and a raise scrolls it into view.
      const bounds = payload.bounds as Record<string, unknown> | undefined;
      const field: RemoteEditableField | null = bounds && ["x", "y", "w", "h"].every((key) => typeof bounds[key] === "number")
        ? { x: bounds.x as number, y: bounds.y as number, w: bounds.w as number, h: bounds.h as number }
        : null;
      if (field) {
        editableField.current = field;
        editableAtRef.current = Date.now();
      }
      if (imeOnRef.current) scrollRemoteFieldIntoView(field ?? editableField.current);
      else setFieldHint(true);
    } else {
      // Tapped a control or blank area — collapse an open keyboard.
      editableField.current = null;
      if (imeOnRef.current) {
        textInputRef.current?.blur();
        setImeOn(false);
      }
    }
  }, [scrollRemoteFieldIntoView]);
  const webrtcIceServers: RTCIceServer[] = useMemo(() => [{ urls: "stun:stun.l.google.com:19302" }], []);

  const answerWebrtcOffer = useCallback(async (sessionId: string, sdp: RTCSessionDescriptionInit | undefined) => {
    if (!api || !sessionId || !sdp) return;
    try {
      let peer = webrtcPeerRef.current;
      if (!peer) {
        peer = new RTCPeerConnection({ iceServers: webrtcIceServers });
        peer.onicecandidate = (event) => {
          if (!event.candidate) return;
          void api.request("browser:webrtc", { sessionId, data: { kind: "ice", candidate: event.candidate.toJSON() } }).catch(() => undefined);
        };
        peer.ontrack = (event) => {
          const video = webrtcVideoRef.current;
          if (video && event.streams[0]) {
            video.srcObject = event.streams[0];
            void video.play().catch(() => undefined);
          }
        };
        peer.onconnectionstatechange = () => {
          const state = peer?.connectionState;
          if (state === "connected") setWebrtcState("live");
          else if (state === "failed" || state === "disconnected" || state === "closed") setWebrtcState("failed");
        };
        webrtcPeerRef.current = peer;
      }
      await peer.setRemoteDescription(sdp);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      setWebrtcState("connecting");
      await api.request("browser:webrtc", { sessionId, data: { kind: "answer", sdp: peer.localDescription.toJSON() } });
    } catch {
      setWebrtcState("failed");
    }
  }, [api, webrtcIceServers]);

  const handleWebrtcSignal = useCallback((sessionId: string, data: Record<string, unknown> | undefined) => {
    if (!data) return;
    if (data.kind === "quality-state" && ["smooth", "hd", "original"].includes(String(data.quality))) {
      setVideoQuality(String(data.quality)); setPendingQuality(false);
      if (typeof data.error === "string") setError(data.error);
      return;
    }
    if (data.kind === "offer") {
      void answerWebrtcOffer(sessionId, data.sdp as RTCSessionDescriptionInit | undefined);
      return;
    }
    if (data.kind === "ice") {
      const candidate = data.candidate as RTCIceCandidateInit | null | undefined;
      const peer = webrtcPeerRef.current;
      if (peer && candidate) void peer.addIceCandidate(candidate).catch(() => undefined);
      return;
    }
    if (data.kind === "state") {
      const state = String(data.state);
      if (state === "connected") setWebrtcState("live");
      else if (state === "failed" || state === "disconnected" || state === "closed") setWebrtcState("failed");
    }
  }, [answerWebrtcOffer]);

  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!frame) { setFrameSrc(null); return; }
    const next = typeof frame.data === "string"
      ? `data:${frame.mime};base64,${frame.data}`
      : URL.createObjectURL(new Blob([frame.data], { type: frame.mime }));
    let cancelled = false;
    let committed = false;
    const image = new Image();
    image.src = next;
    // Keep the currently decoded frame visible until its replacement is ready.
    // Assigning each incoming blob immediately can expose the black background
    // while the browser asynchronously decodes it.
    void image.decode().then(() => {
      if (cancelled) return;
      committed = true;
      setFrameSrc(next);
    }).catch(() => { /* Keep the last good frame if a frame cannot decode. */ });
    return () => {
      cancelled = true;
      if (!committed && next.startsWith("blob:")) URL.revokeObjectURL(next);
    };
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
      // Refresh means the PICTURE, not just the list: re-deliver the latest
      // JPEG frame (same-session watch keeps the controller role) and
      // renegotiate the real-time video stream.
      if (selectedId) {
        await api.request<{ session: BrowserLiveSession }>("browser:watch", { sessionId: selectedId })
          .then((watched) => mergeSession(watched.session))
          .catch(() => undefined);
      }
      setViewNonce((nonce) => nonce + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法读取浏览器会话");
    } finally {
      setLoading(false);
    }
  }, [agentSessionId, api, mergeSession, open, selectedId]);

  useEffect(() => {
    if (!open || !api) return;
    void refresh();
    return api.onEvent((event) => {
      if (event.type === "browser:frame") {
        const nextFrame = event as unknown as BrowserFrame & { type: string };
        if (nextFrame.sessionId === selectedId) setFrame(nextFrame);
        return;
      }
      if (event.type === "browser:webrtc") {
        const data = (event as unknown as { data?: Record<string, unknown> }).data;
        if (event.sessionId === selectedId) handleWebrtcSignal(selectedId, data);
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
  }, [api, handleWebrtcSignal, mergeSession, open, refresh, selectedId]);

  useEffect(() => {
    if (!open || !api || !selectedId) return;
    setFrame(null);
    setError(null);
    void api.request<{ session: BrowserLiveSession }>("browser:watch", { sessionId: selectedId })
      .then((result) => mergeSession(result.session))
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "无法观看浏览器"));
    return () => { void api.request("browser:unwatch").catch(() => undefined); };
  }, [api, mergeSession, open, selectedId]);

  // Real-time WebRTC video runs while this viewer controls the desktop source;
  // the JPEG stream keeps flowing as fallback and reconnect preview.
  useEffect(() => {
    if (!open || !api || !hasControl || !isDesktop || !selectedId) {
      webrtcPeerRef.current?.close();
      webrtcPeerRef.current = null;
      if (webrtcVideoRef.current) webrtcVideoRef.current.srcObject = null;
      setWebrtcState("off");
      return;
    }
    webrtcPeerRef.current?.close();
    webrtcPeerRef.current = null;
    setWebrtcState("connecting");
    void api.request("browser:webrtc", { sessionId: selectedId, data: { kind: "start" } }).catch(() => setWebrtcState("failed"));
    return () => {
      webrtcPeerRef.current?.close();
      webrtcPeerRef.current = null;
      if (webrtcVideoRef.current) webrtcVideoRef.current.srcObject = null;
      void api.request("browser:webrtc", { sessionId: selectedId, data: { kind: "stop" } }).catch(() => undefined);
    };
  }, [api, hasControl, isDesktop, open, selectedId, viewNonce]);

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

  // Remote system actions (Windows): lock / wake / unlock. The password only
  // lives inside the unlock round-trip and is never kept in component state
  // beyond the dialog field.
  const sendSystem = useCallback(async (action: "lock" | "wake", password?: string) => {
    if (!api || !selectedId) return;
    setSystemBusy(action);
    setError(null);
    try {
      await api.request("browser:system", { sessionId: selectedId, action, ...(password ? { password } : {}) });
      // The producer republishes availability after a state change; re-watch
      // so the panel follows the locked/unlocked transition immediately.
      window.setTimeout(() => setViewNonce((nonce) => nonce + 1), 800);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "系统操作失败");
    } finally {
      setSystemBusy(null);
    }
  }, [api, selectedId]);

  const submitUnlock = useCallback(async () => {
    if (!api || !selectedId || !unlockPassword) return;
    setUnlockPending(true);
    setUnlockError(null);
    try {
      await api.request("browser:system", { sessionId: selectedId, action: "unlock", password: unlockPassword });
      setUnlockPassword("");
      setUnlockOpen(false);
      window.setTimeout(() => setViewNonce((nonce) => nonce + 1), 2500);
    } catch (requestError) {
      setUnlockError(requestError instanceof Error ? requestError.message : "解锁失败");
    } finally {
      setUnlockPassword("");
      setUnlockPending(false);
    }
  }, [api, selectedId, unlockPassword]);

  const sendInput = useCallback((input: Record<string, unknown>) => {
    if (!api || pendingDisplayId || pendingQuality || !selected?.isController || selected.state !== "user-controlled") return;
    void api.request("browser:input", { sessionId: selected.id, input }).catch((requestError) => {
      setError(requestError instanceof Error ? requestError.message : "浏览器输入失败");
    });
  }, [api, selected, pendingDisplayId, pendingQuality]);

  /** Sends a bare key press to the remote (down+up). */
  const sendKey = useCallback((key: string, code: string, modifiers: string[] = []) => {
    sendInput({ kind: "key", action: "down", key, code, text: "", modifiers });
    sendInput({ kind: "key", action: "up", key, code, text: "", modifiers });
  }, [sendInput]);

  /** Sends a Ctrl+<letter> combo (copy/paste/select/…). */
  const sendCombo = useCallback((letter: string) => {
    sendKey(letter, `Key${letter.toUpperCase()}`, ["Control"]);
  }, [sendKey]);

  /** Sends input and resolves with the desktop hit-test reply (null otherwise). */
  const dispatchInputForResult = useCallback((input: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    if (!api || pendingDisplayId || pendingQuality || !selected?.isController || selected.state !== "user-controlled") return Promise.resolve(null);
    return api.request<Record<string, unknown> | null>("browser:input", { sessionId: selected.id, input })
      .then((result) => (result && typeof result === "object" ? result : null))
      .catch(() => null);
  }, [api, selected, pendingDisplayId, pendingQuality]);

  const sendTapUp = useCallback((point: { x: number; y: number }, click?: number) => {
    void dispatchInputForResult({ kind: "pointer", action: "up", ...point, button: "left", ...(click && click > 1 ? { click } : {}) }).then(applyHitTest);
  }, [applyHitTest, dispatchInputForResult]);

  // Soft-keyboard typing: the hidden input accumulates, so only the delta is
  // sent (delimited by the last sent value). IME composition (pinyin) emits
  // intermediate values — suppress those and send only the committed text on
  // compositionend, otherwise the remote receives every pinyin letter.
  const composingRef = useRef(false);
  const lastTypedRef = useRef("");
  const sendTypedText = useCallback((value: string) => {
    const last = lastTypedRef.current;
    if (value === last) return;
    if (value.startsWith(last)) {
      const added = value.slice(last.length);
      if (added) sendInput({ kind: "key", action: "down", text: added, key: "", code: "", modifiers: [] });
    }
    // A shrinking value means a deletion — already delivered as Backspace.
    lastTypedRef.current = value;
  }, [sendInput]);

  const liveDisplays = selected?.displays ?? null;
  useEffect(() => {
    if (!pendingQuality) return;
    const timer = window.setTimeout(() => { setPendingQuality(false); setError("画质切换未完成，请刷新画面后重试"); }, 14000);
    return () => window.clearTimeout(timer);
  }, [pendingQuality]);
  useEffect(() => { setPendingQuality(false); setVideoQuality("hd"); }, [open, selectedId]);
  const selectQuality = (quality: string) => {
    if (!api || !canAdjustCapture || pendingDisplayId || pendingQuality || !selectedId) return;
    setPendingQuality(true);
    void api.request("browser:webrtc", { sessionId: selectedId, data: { kind: "quality", quality } }).catch(error => {
      setPendingQuality(false); setError(error instanceof Error ? error.message : "画质切换失败");
    });
  };
  useEffect(() => {
    if (!pendingDisplayId) return;
    if (liveDisplays?.some(display => display.id === pendingDisplayId && display.selected)) {
      setPendingDisplayId(null); return;
    }
    const timer = window.setTimeout(() => { setPendingDisplayId(null); setError("切换屏幕未完成，请刷新画面后重试"); }, 14000);
    return () => window.clearTimeout(timer);
  }, [liveDisplays, pendingDisplayId]);
  useEffect(() => { setPendingDisplayId(null); }, [open, selectedId]);
  const windowControlAtRef = useRef(0);
  const selectDisplay = useCallback((displayId: string) => {
    if (!api || pendingDisplayId || pendingQuality || !selectedId || !canAdjustCapture || !liveDisplays?.some(item => item.id === displayId && !item.selected)) return;
    setPendingDisplayId(displayId);
    void api.request("browser:set-display", { sessionId: selectedId, displayId }).catch((requestError) => {
      setPendingDisplayId(null);
      setError(requestError instanceof Error ? requestError.message : "切换屏幕失败");
    });
  }, [api, liveDisplays, selectedId, canAdjustCapture, pendingDisplayId, pendingQuality]);

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
    <div className="browser-live-backdrop" data-tab-swipe-ignore role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={panelRef} className={`browser-live-panel ${fullscreen ? "is-fullscreen" : ""} ${sessions.length > 1 ? "has-session-tabs" : ""}`} role="dialog" aria-modal="true" aria-label="浏览器直播">
        <header className="browser-live-header">
          <div className="browser-live-heading">
            <MonitorUp size={17} aria-hidden="true" />
            <div>
              <strong>浏览器直播</strong>
              <span>{selected ? backendLabel(selected.backend) : "实时观看与接管"}</span>
            </div>
            {headerControl}
          </div>
          <div className="browser-live-header-actions">
            <button type="button" className="ui-icon-button" onClick={() => void toggleFullscreen()} title={fullscreen ? "退出全屏" : "全屏"} aria-label={fullscreen ? "退出全屏" : "全屏"} aria-pressed={fullscreen}>
              {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
            </button>
            <button type="button" className="ui-icon-button" onClick={() => void refresh()} title="刷新画面与会话" aria-label="刷新直播画面与会话">
              <RotateCcw size={15} className={loading ? "spin" : undefined} aria-hidden="true" />
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

        <div className={`browser-live-surface ${hasControl ? "is-controlling" : ""} has-zoom ${hasControl && !panMode && quickKeysOpen ? "has-quickkeys" : ""}`}>
          {(
            <div className="browser-live-zoom" role="group" aria-label="桌面画面缩放">
              {isDesktop && liveDisplays && liveDisplays.length > 0 && (
                <LiveViewSelect
                  label="选择直播屏幕"
                  title={canAdjustCapture ? "选择直播屏幕" : "其他设备控制中或画面暂不可用"}
                  value={(liveDisplays.find(item => item.selected) ?? liveDisplays[0]).id}
                  busy={!!pendingDisplayId}
                  disabled={!frame || !canAdjustCapture || pendingQuality || liveDisplays.length < 2}
                  onChange={selectDisplay}
                >
                  {liveDisplays.map((display, index) => <option key={display.id} value={display.id}>{`第 ${index + 1} 屏${display.primary ? "（主屏）" : ""}`}</option>)}
                </LiveViewSelect>
              )}
              {selectedId === "cli-desktop:primary" && (
                <LiveViewSelect label="视频画质" title={canAdjustCapture ? "视频画质" : "其他设备控制中或画面暂不可用"} value={videoQuality} busy={pendingQuality} disabled={!canAdjustCapture || !!pendingDisplayId} compact onChange={selectQuality}>
                  <option value="smooth">流畅</option><option value="hd">高清</option><option value="original">原画</option>
                </LiveViewSelect>
              )}
              <button type="button" aria-label="缩小桌面画面" title="缩小" disabled={!frame || zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><ZoomOut size={16} /></button>
              <output aria-label="桌面缩放比例">{Math.round(zoom * 100)}%</output>
              <button type="button" aria-label="放大桌面画面" title="放大" disabled={!frame || zoom >= 5} onClick={() => setZoom((value) => Math.min(5, value + 0.25))}><ZoomIn size={16} /></button>
              <button type="button" disabled={!frame} onClick={() => { setZoom(1); setPanMode(false); viewportRef.current?.scrollTo(0, 0); }}>适应窗口</button>
              <button type="button" aria-label="移动桌面画面" aria-pressed={panMode} title="拖动或滚动画面，不发送远程输入" disabled={!frame} onClick={() => setPanMode((value) => !value)}><Hand size={15} />移动画面</button>
              <button type="button" aria-label="唤起键盘" aria-pressed={imeOn} title="唤起/收起键盘（轻点输入框也会自动弹起）" className={fieldHint && !imeOn ? "is-hint" : undefined} disabled={!frame || !hasControl} onClick={() => { setFieldHint(false); toggleIme(); }}><Keyboard size={15} />键盘</button>
              <button type="button" aria-label="快捷键条" aria-pressed={quickKeysOpen} title="展开/收起快捷键（Esc/Tab/复制/粘贴/方向键）" disabled={!frame || !hasControl} onClick={() => setQuickKeysOpen((open) => !open)}><Keyboard size={15} />{quickKeysOpen ? "收起" : "快捷键"}</button>
              <button type="button" aria-label="窗口控制" title="全屏看不到左上角按钮时用：第 1 次点=退出全屏（ESC + Ctrl+Cmd+F），第 2 次点=关闭窗口（Cmd+W）" disabled={!frame || !hasControl} onClick={() => {
                const now = Date.now();
                if (now - windowControlAtRef.current < 2500) {
                  // Second tap within 2.5s closes the (now un-fullscreened) window.
                  sendKey("w", "KeyW", ["Meta"]);
                  windowControlAtRef.current = 0;
                  return;
                }
                windowControlAtRef.current = now;
                // Exit fullscreen: Escape covers Chromium-style, Ctrl+Cmd+F
                // covers native macOS fullscreen (either may apply, both are safe).
                sendKey("Escape", "Escape");
                window.setTimeout(() => {
                  sendKey("f", "KeyF", ["Control", "Meta"]);
                }, 150);
              }}><Keyboard size={15} />窗口</button>
              {isWindowsDesktop && (
                <>
                  <button type="button" aria-label="锁屏" title="锁屏（锁屏后仍可从空态区唤醒或远程解锁）" disabled={!frame || !!systemBusy} onClick={() => void sendSystem("lock")}>
                    {systemBusy === "lock" ? <LoaderCircle size={15} className="spin" /> : <Lock size={15} />}锁屏
                  </button>
                  <button type="button" aria-label="唤醒屏幕" title="唤醒显示器或锁屏界面" disabled={!!systemBusy} onClick={() => void sendSystem("wake")}>
                    {systemBusy === "wake" ? <LoaderCircle size={15} className="spin" /> : <Power size={15} />}唤醒
                  </button>
                </>
              )}

            </div>
          )}
          {hasControl && !panMode && quickKeysOpen && (
            <div className="browser-live-quickkeys" role="group" aria-label="快捷键">
              <button type="button" disabled={!frame} onClick={() => sendKey("Escape", "Escape")}>Esc</button>
              <button type="button" disabled={!frame} onClick={() => sendKey("Tab", "Tab")}>Tab</button>
              <button type="button" disabled={!frame} onClick={() => sendCombo("c")}>复制</button>
              <button type="button" disabled={!frame} onClick={() => sendCombo("v")}>粘贴</button>
              <button type="button" disabled={!frame} onClick={() => sendCombo("a")}>全选</button>
              <button type="button" disabled={!frame} onClick={() => sendCombo("z")}>撤销</button>
              <button type="button" disabled={!frame} onClick={() => sendCombo("s")}>保存</button>
              <button type="button" disabled={!frame} onClick={() => sendCombo("f")}>查找</button>
              <button type="button" disabled={!frame} title="退出当前前台应用（Cmd+Q）" onClick={() => sendKey("q", "KeyQ", ["Meta"])}>⌘Q</button>
              <button type="button" disabled={!frame} onClick={() => sendKey("ArrowLeft", "ArrowLeft")}>←</button>
              <button type="button" disabled={!frame} onClick={() => sendKey("ArrowUp", "ArrowUp")}>↑</button>
              <button type="button" disabled={!frame} onClick={() => sendKey("ArrowDown", "ArrowDown")}>↓</button>
              <button type="button" disabled={!frame} onClick={() => sendKey("ArrowRight", "ArrowRight")}>→</button>
            </div>
          )}
          <div className="browser-live-touch-hint">滑动滚动 · 轻点点击 · 双击打开 · 长按拖动 · 按住1秒右键 · 双指缩放</div>
          <div ref={viewportRef} className="browser-live-viewport">
            {frame && frameSrc ? (
              <div
                className="browser-live-image-hit-area"
                style={fitScale && viewport ? {
                  width: viewport.width * fitScale * zoom,
                  height: viewport.height * fitScale * zoom,
                  cursor: panMode ? "grab" : undefined,
                } : undefined}
                tabIndex={hasControl && !panMode ? 0 : -1}
                onPointerDown={(event) => {
                  if (event.pointerType === "touch") {
                    event.preventDefault();
                    touch.current.down(event.pointerId, { x: event.clientX, y: event.clientY });
                    touchGesturePoint.current = hasControl && !panMode ? pointerCoordinates(event) : null;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    // Arm long-press (drag / right-click) while controlling.
                    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
                    longPressRef.current = "none";
                    touchStartRef.current = hasControl && !panMode ? { x: event.clientX, y: event.clientY } : null;
                    touchDownAtRef.current = Date.now();
                    if (touchStartRef.current) {
                      longPressTimer.current = window.setTimeout(() => { longPressRef.current = "armed"; }, 550);
                    }
                    return;
                  }
                  if (panMode && viewportRef.current) {
                    const element = viewportRef.current;
                    panStart.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
                    event.currentTarget.setPointerCapture(event.pointerId);
                    return;
                  }
                  if (!hasControl) return;
                  const point = pointerCoordinates(event);
                  if (!point) return;
                  pointerDown.current = true;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  sendInput({ kind: "pointer", action: "down", ...point, button: "left" });
                }}
                onPointerMove={(event) => {
                  if (event.pointerType === "touch") {
                    event.preventDefault();
                    const movement = touch.current.move(event.pointerId, { x: event.clientX, y: event.clientY });
                    const element = viewportRef.current;
                    if (!movement || !element) return;
                    // A real pinch moves the finger distance ≥5% from where the
                    // gesture began; parallel translation with sub-percent
                    // jitter must fall through to scrolling/panning instead.
                    const isPinch = movement.pointers >= 2 && Math.abs(movement.distanceRatio - 1) > 0.05;
                    const nextZoom = Math.max(0.5, Math.min(5, zoomRef.current * movement.scale));
                    if (isPinch && nextZoom !== zoomRef.current) {
                      const rect = event.currentTarget.getBoundingClientRect();
                      zoomAnchor.current = {
                        x: (movement.from.x - rect.left) / rect.width,
                        y: (movement.from.y - rect.top) / rect.height,
                        clientX: movement.to.x, clientY: movement.to.y,
                      };
                      zoomRef.current = nextZoom;
                      // Commit geometry before the next finger move reads its anchor.
                      flushSync(() => setZoom(nextZoom));
                      return;
                    }
                    // A swipe cancels the pending long-press.
                    if (longPressTimer.current) {
                      window.clearTimeout(longPressTimer.current);
                      longPressTimer.current = null;
                    }
                    // Armed long-press + movement = remote drag.
                    if (longPressRef.current === "armed" && touchStartRef.current) {
                      longPressRef.current = "drag";
                      const dragPoint = pointerCoordinates(event);
                      if (dragPoint) sendInput({ kind: "pointer", action: "down", ...dragPoint, button: "left" });
                    }
                    if (longPressRef.current === "drag") {
                      const dragPoint = pointerCoordinates(event);
                      if (dragPoint) sendInput({ kind: "pointer", action: "move", ...dragPoint, button: "left" });
                      return;
                    }
                    // While controlling, finger drags scroll the remote content —
                    // one or two fingers at fit zoom (a fit canvas has nothing to
                    // pan, so "pan" would silently do nothing), two fingers when
                    // zoomed in. One finger only pans the local canvas when
                    // zoomed or in explicit pan mode.
                    const atFitZoom = zoomRef.current <= 1.001;
                    if (hasControl && !panMode && (movement.pointers >= 2 || atFitZoom)) {
                      const delta = touchScrollDelta(movement.from, movement.to);
                      if (delta) {
                        const point = touchGesturePoint.current ?? pointerCoordinates(event);
                        if (point) sendInput({ kind: "pointer", action: "wheel", ...point, ...delta });
                      }
                      return;
                    }
                    element.scrollLeft += movement.from.x - movement.to.x;
                    element.scrollTop += movement.from.y - movement.to.y;
                    return;
                  }
                  if (panMode && panStart.current && viewportRef.current) {
                    const start = panStart.current;
                    viewportRef.current.scrollTo(start.left + start.x - event.clientX, start.top + start.y - event.clientY);
                    return;
                  }
                  if (!hasControl || !pointerDown.current) return;
                  const point = pointerCoordinates(event);
                  if (point) sendInput({ kind: "pointer", action: "move", ...point, button: "left" });
                }}
                onPointerUp={(event) => {
                  if (event.pointerType === "touch") {
                    event.preventDefault();
                    if (longPressTimer.current) { window.clearTimeout(longPressTimer.current); longPressTimer.current = null; }
                    const point = pointerCoordinates(event);
                    touchGesturePoint.current = null;
                    // Stationary long-press release: a deliberate ≥800ms hold
                    // is a right-click; shorter "slow taps" stay a left click —
                    // otherwise every careful tap would pop a context menu.
                    if (longPressRef.current === "armed") {
                      longPressRef.current = "none";
                      const holdMs = touchDownAtRef.current ? Date.now() - touchDownAtRef.current : 0;
                      if (holdMs >= 800 && point && hasControl && !panMode) {
                        touch.current.reset();
                        sendInput({ kind: "pointer", action: "down", ...point, button: "right" });
                        sendInput({ kind: "pointer", action: "up", ...point, button: "right" });
                        return;
                      }
                      // Fall through: handle as a normal left tap below.
                    }
                    // Long-press drag release = left button up.
                    if (longPressRef.current === "drag") {
                      longPressRef.current = "none";
                      touch.current.reset();
                      if (point && hasControl) sendInput({ kind: "pointer", action: "up", ...point, button: "left" });
                      return;
                    }
                    const tap = touch.current.up(event.pointerId, { x: event.clientX, y: event.clientY });
                    if (tap && point && hasControl && !panMode) {
                      // Auto-raise only when the finger lands on a learned text
                      // field; every other tap collapses the keyboard.
                      const cachedEditable = editableField.current;
                      const onKnownField = cachedEditable !== null
                        && Date.now() - editableAtRef.current < 60_000
                        && remoteFieldContains(cachedEditable, frame?.viewport ?? selected?.viewport, point.x, point.y, 0.03);
                      if (onKnownField && !imeOnRef.current) {
                        textInputRef.current?.focus({ preventScroll: true });
                        setImeOn(true);
                        setFieldHint(false);
                      } else if (!onKnownField && imeOnRef.current) {
                        textInputRef.current?.blur();
                        setImeOn(false);
                      }
                      const vp = frame?.viewport ?? selected?.viewport;
                      const last = lastTapRef.current;
                      const isDouble = last !== null && Date.now() - last.at < 400 && vp !== undefined
                        && Math.hypot((point.x - last.x) * vp.width, (point.y - last.y) * vp.height) < vp.width * 0.03;
                      if (isDouble) {
                        // Second tap of a double: replay as a real double-click.
                        sendInput({ kind: "pointer", action: "down", ...point, button: "left", click: 2 });
                        sendTapUp(point, 2);
                        lastTapRef.current = null;
                      } else {
                        sendInput({ kind: "pointer", action: "down", ...point, button: "left" });
                        sendTapUp(point);
                        lastTapRef.current = { at: Date.now(), x: point.x, y: point.y };
                      }
                    }
                    return;
                  }
                  if (panMode) { panStart.current = null; return; }
                  if (!hasControl) return;
                  const point = pointerCoordinates(event);
                  pointerDown.current = false;
                  if (point) sendTapUp(point);
                }}
                onPointerCancel={(event) => {
                  touch.current.up(event.pointerId, { x: event.clientX, y: event.clientY }, true);
                  panStart.current = null; pointerDown.current = false; touchGesturePoint.current = null;
                  if (longPressTimer.current) { window.clearTimeout(longPressTimer.current); longPressTimer.current = null; }
                  longPressRef.current = "none";
                }}
                onLostPointerCapture={(event) => {
                  touch.current.up(event.pointerId, { x: event.clientX, y: event.clientY }, true);
                }}
                onWheel={(event) => {
                  if (!hasControl || panMode) return;
                  const point = pointerCoordinates(event);
                  if (point) sendInput({ kind: "pointer", action: "wheel", ...point, deltaX: event.deltaX, deltaY: event.deltaY });
                }}
                onKeyDown={(event) => {
                  if (!hasControl || panMode) return;
                  // Printable chars typed into the hidden IME input bubble up
                  // here; they are delivered once through onChange instead.
                  if (event.target === textInputRef.current && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
                  sendInput({ kind: "key", action: "down", key: event.key, code: event.code, text: event.key.length === 1 ? event.key : "", modifiers: modifierNames(event) });
                  if (["Backspace", "Tab", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Escape"].includes(event.key)) event.preventDefault();
                }}
                onKeyUp={(event) => {
                  if (!hasControl || panMode) return;
                  if (event.target === textInputRef.current && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
                  if (hasControl) sendInput({ kind: "key", action: "up", key: event.key, code: event.code, modifiers: modifierNames(event) });
                }}
              >
                <img src={frameSrc} alt={selected?.title || "浏览器实时画面"} draggable={false} decoding="async" />
                <video
                  ref={webrtcVideoRef}
                  className={`browser-live-video ${webrtcState === "live" ? "is-live" : ""}`}
                  aria-label={isDesktop ? "桌面实时视频流" : "浏览器实时视频流"}
                  autoPlay
                  playsInline
                  muted
                />
                <input
                  ref={textInputRef}
                  className="browser-live-mobile-input"
                  aria-label="浏览器键盘输入"
                  defaultValue=""
                  inputMode="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  onCompositionStart={() => { composingRef.current = true; }}
                  onCompositionEnd={(event) => {
                    composingRef.current = false;
                    if (!panMode) sendTypedText((event.target as HTMLInputElement).value);
                  }}
                  onBlur={(event) => {
                    composingRef.current = false;
                    lastTypedRef.current = "";
                    event.target.value = "";
                    setImeOn(false);
                  }}
                  onChange={(event) => {
                    if (!panMode && !composingRef.current) sendTypedText(event.target.value);
                  }}
                />
              </div>
            ) : (
              <div className="browser-live-empty">
                {(loading || selected?.availability === "starting") ? <LoaderCircle size={22} className="spin" aria-hidden="true" /> : <MonitorUp size={24} aria-hidden="true" />}
                <strong>{loading ? "正在连接浏览器" : emptyTitle}</strong>
                <span>{emptyDetail}</span>
                {desktopLocked && (
                  <div role="group" aria-label="锁屏远程操作" style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <button type="button" className="browser-live-control-button" disabled={!!systemBusy} onClick={() => void sendSystem("wake")}>
                      {systemBusy === "wake" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Power size={14} aria-hidden="true" />}唤醒屏幕
                    </button>
                    <button type="button" className="browser-live-control-button" disabled={unlockPending} onClick={() => { setUnlockError(null); setUnlockOpen(true); }}>
                      <LockOpen size={14} aria-hidden="true" />远程解锁
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          {hasControl && !panMode && (
            <div className="browser-live-control-cue"><MousePointer2 size={13} aria-hidden="true" /> {isDesktop ? "当前输入会发送到本机" : "当前输入会发送到浏览器"}{isDesktop && webrtcState === "live" ? " · 实时视频流" : isDesktop && webrtcState === "connecting" ? " · 正在连接实时流" : ""}{pingMs != null ? ` · ${pingMs}ms` : ""}</div>
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
      {unlockOpen && (
        <div className="browser-live-unlock-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !unlockPending) {
            setUnlockOpen(false);
            setUnlockPassword("");
            setUnlockError(null);
          }
        }}>
          <form className="browser-live-unlock-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-live-unlock-title" onSubmit={(event) => {
            event.preventDefault();
            void submitUnlock();
          }}>
            <div className="browser-live-unlock-heading">
              <LockOpen size={18} aria-hidden="true" />
              <strong id="browser-live-unlock-title">远程解锁 Windows</strong>
            </div>
            <label htmlFor="browser-live-unlock-password">Windows 密码或 PIN</label>
            <input
              id="browser-live-unlock-password"
              type="password"
              autoComplete="off"
              autoFocus
              maxLength={256}
              value={unlockPassword}
              disabled={unlockPending}
              onChange={(event) => setUnlockPassword(event.target.value)}
            />
            {unlockError && <p role="alert">{unlockError}</p>}
            <div className="browser-live-unlock-actions">
              <button type="button" className="browser-live-control-button is-return" disabled={unlockPending} onClick={() => {
                setUnlockOpen(false);
                setUnlockPassword("");
                setUnlockError(null);
              }}>取消</button>
              <button type="submit" className="browser-live-control-button" disabled={unlockPending || !unlockPassword}>
                {unlockPending && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
                解锁
              </button>
            </div>
          </form>
        </div>
      )}
    </div>,
    document.body,
  );
}

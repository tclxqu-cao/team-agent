"use client";
// TerminalPane — xterm.js wired to the gateway. Always mounted (overlays sit
// above it so navigation never unmounts the terminal), handles mobile
// soft-keyboard resizing, touch scroll forwarding, and cwd reporting.

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { GatewayState } from "./useGateway";
import type { WebTheme } from "./themes";
import { resetHorizontalScroll } from "./mobileViewport";
import { shouldSuppressTouchScrollInput } from "./terminalInputPolicy";

const KEY_STYLES_BASE: React.CSSProperties = {
  minWidth: 34,
  height: 30,
  borderRadius: 7,
  fontSize: 11.5,
  padding: "0 7px",
  touchAction: "none",
  userSelect: "none" as const,
  flexShrink: 0,
};

const DEFAULT_KEY_ORDER = ["ctrl","esc","tab","up","down","left","right","pgup","pgdown","end","enter","pipe","tilde","dash","slash","ctrlc","ctrld","ctrll","hide"];
const KEY_LABELS: Record<string,string> = {ctrl:"Ctrl",esc:"Esc",tab:"Tab",up:"↑",down:"↓",left:"←",right:"→",pgup:"Pg↑",pgdown:"Pg↓",end:"End",enter:"↵",pipe:"|",tilde:"~",dash:"-",slash:"/",ctrlc:"^C",ctrld:"^D",ctrll:"^L",hide:"隐藏"};

interface Props {
  terminalId: string;
  title: string;
  visible: boolean;
  state: GatewayState;
  rpc: <T = any,>(type: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  onEvent: (type: string, fn: (msg: any) => void) => () => void;
  onTerminalData: (channelId: number, fn: (data: Uint8Array) => void) => () => void;
  sendTerminalInput: (channelId: number, data: string) => boolean;
  keyOrder: string[];
  keybarHidden: boolean;
  onKeyOrderChange: (order: string[]) => void;
  onKeybarHiddenChange: (hidden: boolean) => void;
  /** called whenever the shell's working directory changes */
  onCwdChange?: (cwd: string | null) => void;
  /** persisted scroll line from device state */
  initialScrollLine?: number | null;
  onScrollLineChange?: (line: number) => void;
  /** register a handler that fills the live prompt without executing */
  onRegisterFill?: (fill: (command: string) => void) => () => void;
  terminalTheme: WebTheme;
}

export default function TerminalPane({ terminalId, title, visible, state, rpc, onEvent, onTerminalData, sendTerminalInput, keyOrder, keybarHidden, onKeyOrderChange, onKeybarHiddenChange, onCwdChange, initialScrollLine, onScrollLineChange, onRegisterFill, terminalTheme }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [writeLocked, setWriteLocked] = useState(false);
  const ctrlArmed = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  const sessionId = useRef<string>(terminalId);
  const channelId = useRef<number | null>(null);
  const dataSubscription = useRef<(() => void) | null>(null);
  const writer = useRef<(bytes: Uint8Array) => void>(() => {});
  const startRequestRef = useRef<Promise<{ sessionId: string; channelId: number; cwd?: string | null }> | null>(null);
  const followOutputRef = useRef(true);
  const lockedViewportYRef = useRef(0);
  const keybarRef = useRef<HTMLDivElement>(null);
  const keyDrag = useRef<{ key: string; timer: ReturnType<typeof setTimeout> | null; active: boolean; startX: number; startY: number; lastX: number; scrolling: boolean } | null>(null);
  const suppressKeyClick = useRef(false);
  const touchKeyTap = useRef<{ key:string; dragged:boolean } | null>(null);
  const tabFocusCount = useRef(0);
  const suppressTerminalClickScroll = useRef(false);
  const touchScrollActiveRef = useRef(false);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const sendInput = useCallback((data: string) => {
    if (channelId.current != null && sendTerminalInput(channelId.current, data)) return;
    rpc("term:input", { id: sessionId.current, data }).catch(() => {});
  }, [rpc, sendTerminalInput]);
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;
  const fillCommandRef = useRef<(command: string) => void>(() => {});
  const terminalThemeRef = useRef(terminalTheme);
  terminalThemeRef.current = terminalTheme;
  const keyStyles: React.CSSProperties = {
    ...KEY_STYLES_BASE,
    border: `1px solid ${terminalTheme.keybar.keyBorder}`,
    background: terminalTheme.keybar.keyBg,
    color: terminalTheme.keybar.keyText,
  };
  const onRegisterFillRef = useRef(onRegisterFill);
  onRegisterFillRef.current = onRegisterFill;
  const fillCommand = useCallback((command: string) => {
    void (async () => {
      followOutputRef.current = true;
      termRef.current?.scrollToBottom();
      try {
        await rpc("term:focus", { id: sessionId.current });
        setWriteLocked(false);
      } catch (error: any) {
        if (error?.code === "EWRITELOCK") {
          setWriteLocked(true);
          return;
        }
      }
      termRef.current?.focus();
      sendInput("\x15");
      window.setTimeout(() => {
        const term = termRef.current;
        if (!term) return;
        if (typeof term.paste === "function") term.paste(command);
        else sendInput(command);
      }, 20);
    })();
  }, [rpc, sendInput]);
  fillCommandRef.current = fillCommand;
  const reportScrollLine = useCallback(() => {
    const t = termRef.current;
    if (!t || !onScrollLineChange) return;
    onScrollLineChange(followOutputRef.current ? t.buffer.active.baseY : t.buffer.active.viewportY);
  }, [onScrollLineChange]);
  const reportScrollLineRef = useRef(reportScrollLine);
  reportScrollLineRef.current = reportScrollLine;
  const scrollViewportLinesRef = useRef((lines: number) => {
    const term = termRef.current;
    if (!term || term.buffer.active.type === "alternate") return;
    if (lines === 0) return;
    followOutputRef.current = false;
    term.scrollLines(lines);
    lockedViewportYRef.current = term.buffer.active.viewportY;
    followOutputRef.current = term.buffer.active.viewportY >= term.buffer.active.baseY;
    reportScrollLineRef.current();
  });
  const scrollViewportPagesRef = useRef((pages: number) => {
    const term = termRef.current;
    if (!term || term.buffer.active.type === "alternate") return;
    if (pages === 0) return;
    if (pages < 0) followOutputRef.current = false;
    term.scrollPages(pages);
    lockedViewportYRef.current = term.buffer.active.viewportY;
    followOutputRef.current = term.buffer.active.viewportY >= term.buffer.active.baseY;
    reportScrollLineRef.current();
  });
  const applySavedScroll = useCallback(() => {
    const t = termRef.current;
    if (!t || initialScrollLine == null) return;
    const maxLine = t.buffer.active.baseY;
    if (initialScrollLine >= maxLine) {
      followOutputRef.current = true;
      t.scrollToBottom();
      return;
    }
    followOutputRef.current = false;
    lockedViewportYRef.current = initialScrollLine;
    t.scrollToLine(initialScrollLine);
  }, [initialScrollLine]);

  // init xterm once per gateway epoch (key remount)
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, Consolas, monospace',
      fontSize: window.innerWidth <= 768 ? 11 : 12,
      lineHeight: 1.12,
      letterSpacing: 0,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      scrollOnUserInput: false,
      smoothScrollDuration: 0,
      scrollSensitivity: 1,
      theme: terminalThemeRef.current.xterm,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch {}

    // Standard terminal cwd notification: OSC 7 ; file://host/path ST.
    // Agents/shell integrations that expose their internal workspace can
    // update the file tree even when the parent process never calls chdir().
    const osc7 = term.parser.registerOscHandler(7, (payload) => {
      try {
        const value = payload.startsWith("file://") ? payload : `file://${payload}`;
        const url = new URL(value);
        if (url.protocol !== "file:") return false;
        let cwd = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:\//.test(cwd)) cwd=cwd.slice(1);
        if (cwd.startsWith("/") || /^[A-Za-z]:\//.test(cwd)) { onCwdChange?.(cwd); rpc("term:set-cwd",{id:sessionId.current,cwd}).catch(()=>{}); }
        return true;
      } catch {
        return false;
      }
    });

    writer.current = (bytes) => {
      term.write(bytes, () => {
        // Alternate-screen TUIs (opencode, claude code) redraw the full frame;
        // scrolling xterm's viewport corrupts their layout.
        if (term.buffer.active.type === "alternate") return;
        const xtermElement = hostRef.current?.querySelector<HTMLElement>(".xterm");
        if (xtermElement?.style.transform) { xtermElement.style.transform = ""; xtermElement.style.willChange = ""; }
        if (followOutputRef.current) term.scrollToBottom();
        else term.scrollToLine(Math.min(lockedViewportYRef.current, term.buffer.active.baseY));
      });
    };

    term.onData((data) => {
      if (!state.connected) return;
      // Swipe on mobile can still leak arrow escapes into readline command history.
      if (shouldSuppressTouchScrollInput(data, touchScrollActiveRef.current)) return;
      // Typing a command intentionally returns to the live prompt.
      followOutputRef.current = true;
      if (term.buffer.active.type !== "alternate") term.scrollToBottom();
      reportScrollLine();
      if (ctrlArmed.current && data.length === 1) {
        const code = data.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) data = String.fromCharCode(code - 96);
        else if (data === " ") data = "\x00";
        else if (data === "[") data = "\x1b";
        else if (data === "\\") data = "\x1c";
        else if (data === "]") data = "\x1d";
        disarmCtrl();
      }
      sendInput(data);
    });

    let resizeTimer: ReturnType<typeof setTimeout>;
    term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        rpc("term:resize", { id: sessionId.current, cols, rows }).catch(() => {});
      }, 120);
    });

    const scrollDisposable = term.onScroll((ydisp) => {
      const buf = term.buffer.active;
      const atBottom = ydisp >= buf.baseY;
      followOutputRef.current = atBottom;
      if (!atBottom) lockedViewportYRef.current = ydisp;
      reportScrollLineRef.current();
    });

    // Mobile swipe on the focused xterm textarea often becomes ArrowUp/Down keydown,
    // which readline treats as command history. In normal buffer, scroll viewport instead.
    term.attachCustomKeyEventHandler((event) => {
      if (term.buffer.active.type === "alternate" || event.type !== "keydown") return true;
      const atLivePrompt = term.buffer.active.viewportY >= term.buffer.active.baseY;
      const scrollInstead =
        event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "PageUp" || event.key === "PageDown";
      if (!scrollInstead) return true;
      // At live prompt only swallow arrows during an active finger scroll; when
      // scrolled up, arrows always move the xterm viewport (not readline history).
      if (atLivePrompt && !touchScrollActiveRef.current) return true;
      if (event.key === "ArrowUp") {
        scrollViewportLinesRef.current(-1);
        event.preventDefault();
        return false;
      }
      if (event.key === "ArrowDown") {
        scrollViewportLinesRef.current(1);
        event.preventDefault();
        return false;
      }
      if (event.key === "PageUp") {
        scrollViewportPagesRef.current(-1);
        event.preventDefault();
        return false;
      }
      if (event.key === "PageDown") {
        scrollViewportPagesRef.current(1);
        event.preventDefault();
        return false;
      }
      return true;
    });

    term.attachCustomWheelEventHandler((event) => {
      if (term.buffer.active.type === "alternate") return true;
      if (!event.deltaY) return true;
      const cellH = Math.max(8, (hostRef.current?.clientHeight ?? term.rows * 14) / Math.max(term.rows, 1));
      const steps = Math.trunc(event.deltaY / cellH) || (event.deltaY > 0 ? 1 : -1);
      scrollViewportLinesRef.current(steps);
      return false;
    });

    // Normal buffer (agent-tui / shell scrollback): finger scroll moves xterm viewport only.
    // Alternate-screen TUIs handle their own input — never forward swipe as arrow keys.
    let touchPointerId: number | null = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchLastY = 0;
    let touchAcc = 0;
    let touchTracking = false;
    let touchAxis: "pending" | "horizontal" | "vertical" = "pending";
    let lastAlternateScrollAt = 0;
    const scrollSurface = term.element ?? hostRef.current;
    const onTouchDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      touchPointerId = event.pointerId;
      touchStartX = event.clientX;
      touchStartY = event.clientY;
      touchLastY = event.clientY;
      touchAcc = 0;
      touchAxis = "pending";
      touchTracking = true;
      touchScrollActiveRef.current = true;
      if (term.buffer.active.type !== "alternate") followOutputRef.current = false;
      try { scrollSurface?.setPointerCapture(event.pointerId); } catch {}
    };
    const onTouchMove = (event: PointerEvent) => {
      if (!touchTracking || event.pointerId !== touchPointerId) return;
      const totalX = event.clientX - touchStartX;
      const totalY = event.clientY - touchStartY;
      if (touchAxis === "pending" && Math.max(Math.abs(totalX), Math.abs(totalY)) > 8) {
        touchAxis = Math.abs(totalX) > Math.abs(totalY) * 1.2 ? "horizontal" : "vertical";
      }
      if (touchAxis !== "vertical") return;
      const dy = touchLastY - event.clientY;
      touchLastY = event.clientY;
      touchAcc += dy;
      if (term.buffer.active.type === "alternate") {
        const rect = scrollSurface?.getBoundingClientRect();
        const col = rect ? Math.max(1, Math.min(term.cols, Math.floor((event.clientX - rect.left) / Math.max(rect.width, 1) * term.cols) + 1)) : 1;
        const row = rect ? Math.max(1, Math.min(term.rows, Math.floor((event.clientY - rect.top) / Math.max(rect.height, 1) * term.rows) + 1)) : 1;
        if (term.modes.mouseTrackingMode !== "none") {
          const steps = Math.trunc(touchAcc / 18);
          const now = performance.now();
          if (steps !== 0 && now - lastAlternateScrollAt >= 32) {
            const boundedSteps = Math.sign(steps) * Math.min(2, Math.abs(steps));
            touchAcc -= boundedSteps * 18;
            lastAlternateScrollAt = now;
            const wheelCode = steps < 0 ? 64 : 65;
            sendInput(`\x1b[<${wheelCode};${col};${row}M`.repeat(Math.abs(boundedSteps)));
          }
        } else {
          const pages = Math.trunc(touchAcc / 64);
          const now = performance.now();
          if (pages !== 0 && now - lastAlternateScrollAt >= 80) {
            const boundedPages = Math.sign(pages);
            touchAcc -= boundedPages * 64;
            lastAlternateScrollAt = now;
            // Finger down (negative) reads older content → PageUp. Never use ArrowUp/Down.
            sendInput(boundedPages < 0 ? "\x1b[5~" : "\x1b[6~");
          }
        }
        event.preventDefault();
        suppressTerminalClickScroll.current = true;
        return;
      }
      const hostH = scrollSurface?.clientHeight ?? term.rows * 14;
      const cellH = Math.max(8, (hostH / Math.max(term.rows, 1)) | 0);
      const steps = Math.trunc(touchAcc / cellH);
      if (steps !== 0) {
        touchAcc -= steps * cellH;
        scrollViewportLinesRef.current(steps);
        event.preventDefault();
        suppressTerminalClickScroll.current = true;
      }
    };
    const onTouchEnd = (event: PointerEvent) => {
      if (event.pointerId !== touchPointerId) return;
      try { scrollSurface?.releasePointerCapture(event.pointerId); } catch {}
      if (Math.abs(touchAcc) > 8) {
        window.setTimeout(() => { suppressTerminalClickScroll.current = false; }, 400);
      }
      touchTracking = false;
      touchPointerId = null;
      touchAxis = "pending";
      window.setTimeout(() => { touchScrollActiveRef.current = false; }, 450);
    };
    scrollSurface?.addEventListener("pointerdown", onTouchDown, { capture: true });
    scrollSurface?.addEventListener("pointermove", onTouchMove, { capture: true, passive: false });
    scrollSurface?.addEventListener("pointerup", onTouchEnd, { capture: true });
    scrollSurface?.addEventListener("pointercancel", onTouchEnd, { capture: true });

    return () => {
      clearTimeout(resizeTimer);
      scrollDisposable.dispose();
      term.attachCustomKeyEventHandler(() => true);
      term.attachCustomWheelEventHandler(() => true);
      scrollSurface?.removeEventListener("pointerdown", onTouchDown, { capture: true });
      scrollSurface?.removeEventListener("pointermove", onTouchMove, { capture: true });
      scrollSurface?.removeEventListener("pointerup", onTouchEnd, { capture: true });
      scrollSurface?.removeEventListener("pointercancel", onTouchEnd, { capture: true });
      osc7.dispose();
      dataSubscription.current?.();
      onCwdChange?.(null);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalTheme.xterm;
    term.refresh(0, term.rows - 1);
  }, [terminalTheme]);

  const disarmCtrl = () => {
    ctrlArmed.current = false;
    setCtrlOn(false);
  };

  const doFit = useCallback(() => {
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term || !hostRef.current?.isConnected) return false;
    try {
      const dimensions = fit.proposeDimensions();
      if (!dimensions || (dimensions.cols === term.cols && dimensions.rows === term.rows)) return false;
      fit.fit();
      return true;
    } catch { return false; }
  }, []);

  const focusLivePrompt = useCallback((opts?: { restoreScroll?: boolean; forceLive?: boolean }) => {
    const restoreScroll = opts?.restoreScroll ?? false;
    const forceLive = opts?.forceLive ?? false;
    doFit();
    const term = termRef.current;
    if (!term) return;
    const alternate = term.buffer.active.type === "alternate";
    if (restoreScroll && initialScrollLine != null && !alternate) {
      applySavedScroll();
    } else if (!alternate && (forceLive || followOutputRef.current)) {
      if (forceLive) followOutputRef.current = true;
      term.scrollToBottom();
    }
    term.focus();
    reportScrollLine();
    rpc("term:focus", { id: sessionId.current })
      .then(() => setWriteLocked(false))
      .catch((error: any) => { if (error?.code === "EWRITELOCK") setWriteLocked(true); });
  }, [applySavedScroll, doFit, initialScrollLine, reportScrollLine, rpc]);

  // session handshake + cwd subscription
  useEffect(() => {
    if (!state.connected) {
      startRequestRef.current = null;
      channelId.current = null;
      dataSubscription.current?.();
      dataSubscription.current = null;
      setSessionReady(false);
      setSessionError(null);
      tabFocusCount.current = 0;
      return;
    }
    let cancelled = false;
    setSessionError(null);
    doFit();
    requestAnimationFrame(doFit);
    // React StrictMode runs effects twice in development. Reuse one in-flight
    // start promise and one deterministic id, otherwise two shell prompts (or
    // a live prompt plus replay) are written on the very first connection.
    const start =
      startRequestRef.current ??=
        rpc<{ sessionId: string; channelId: number; cwd?: string | null }>("term:start", {
          id: terminalId,
          title,
          cols: termRef.current?.cols ?? 80,
          rows: termRef.current?.rows ?? 24,
        });
    start
      .then((res) => {
        if (cancelled) return;
        sessionId.current = res.sessionId;
        channelId.current = res.channelId;
        dataSubscription.current?.();
        dataSubscription.current = onTerminalData(res.channelId, (bytes) => writer.current(bytes));
        setSessionReady(true);
        onCwdChange?.(res.cwd ?? null);
        window.setTimeout(() => doFit(), 80);
        // Nudge full-screen TUIs (opencode etc.) to repaint after scrollback replay.
        window.setTimeout(() => {
          const t = termRef.current;
          if (!t) return;
          rpc("term:resize", { id: sessionId.current, cols: t.cols, rows: t.rows }).catch(() => {});
        }, 400);
      })
      .catch((error: any) => {
        startRequestRef.current = null;
        if (!cancelled) setSessionError(error?.message || "终端启动失败");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.connected, terminalId, title, onTerminalData]);

  useEffect(() => {
    if (!onRegisterFill) return;
    const register = onRegisterFillRef.current;
    if (!register) return;
    return register((command) => fillCommandRef.current(command));
  }, [terminalId]);

  useEffect(() => {
    if (!visible || !sessionReady) return;
    tabFocusCount.current += 1;
    const restoreScroll = tabFocusCount.current > 1;
    const timer = window.setTimeout(() => {
      const alternate = termRef.current?.buffer.active.type === "alternate";
      focusLivePrompt({ restoreScroll, forceLive: !restoreScroll && !alternate });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [visible, sessionReady, focusLivePrompt]);

  // subscribe cwd changes for the attached session (event pushes)
  useEffect(() => {
    return onEvent("term:cwd", (msg: any) => {
      if (msg.id === sessionId.current && msg.cwd) onCwdChange?.(msg.cwd);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onEvent]);

  // fit on container/viewport changes (mobile keyboard!)
  useEffect(() => {
    const vv = window.visualViewport;
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const alignAlternateBottom = () => {
      const term = termRef.current;
      const host = hostRef.current;
      const xterm = host?.querySelector<HTMLElement>(".xterm");
      const screen = host?.querySelector<HTMLElement>(".xterm-screen");
      if (!term || !host || !xterm) return false;
      if (term.buffer.active.type !== "alternate") {
        if (xterm.style.transform) xterm.style.transform = "";
        return false;
      }
      const contentHeight = screen?.getBoundingClientRect().height ?? host.clientHeight;
      const shift = Math.max(0, contentHeight - host.clientHeight);
      xterm.style.transform = shift > 0 ? `translate3d(0,-${Math.round(shift)}px,0)` : "";
      xterm.style.willChange = shift > 0 ? "transform" : "";
      return true;
    };
    const applyStableFit = () => {
      fitTimer = null;
      requestAnimationFrame(() => {
        // Full-screen TUIs own their row layout. Keep geometry stable while
        // the software keyboard opens/closes and only align the existing
        // screen bottom into the visible host.
        if (alignAlternateBottom()) return;
        const resized = doFit();
        if (!resized) return;
        const t = termRef.current;
        if (!t || t.buffer.active.type === "alternate") return;
        if (followOutputRef.current) {
          if (t.buffer.active.viewportY < t.buffer.active.baseY) t.scrollToBottom();
        } else if (t.buffer.active.viewportY !== lockedViewportYRef.current) {
          t.scrollToLine(Math.min(lockedViewportYRef.current, t.buffer.active.baseY));
        }
      });
    };
    const syncViewport = () => {
      requestAnimationFrame(alignAlternateBottom);
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(applyStableFit, 180);
    };
    syncViewport();
    vv?.addEventListener("resize", syncViewport);
    vv?.addEventListener("scroll", syncViewport);
    window.addEventListener("orientationchange", syncViewport);
    window.addEventListener("resize", syncViewport);
    const ro = new ResizeObserver(syncViewport);
    if (hostRef.current?.parentElement) ro.observe(hostRef.current.parentElement);
    return () => {
      vv?.removeEventListener("resize", syncViewport);
      vv?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      window.removeEventListener("resize", syncViewport);
      if (fitTimer) clearTimeout(fitTimer);
      ro.disconnect();
    };
  }, [doFit]);

  useEffect(() => {
    if (keybarHidden) return;
    const resetRestoredScroll = () => resetHorizontalScroll(keybarRef.current);
    resetRestoredScroll();
    window.addEventListener("pageshow", resetRestoredScroll);
    return () => window.removeEventListener("pageshow", resetRestoredScroll);
  }, [keybarHidden, terminalId]);

  // xterm viewport sizing for native + custom scroll
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.style.display = "flex";
    host.style.flexDirection = "column";
    host.style.minHeight = "0";
    host.style.overflow = "hidden";
    const root = host.querySelector<HTMLElement>(".xterm");
    root?.style.setProperty("flex", "1");
    root?.style.setProperty("height", "100%");
    const viewport = host.querySelector<HTMLElement>(".xterm-scrollable-element, .xterm-viewport");
    viewport?.style.setProperty("touch-action", "pan-y");
    viewport?.style.setProperty("-webkit-overflow-scrolling", "touch");
  }, [sessionReady]);

  // keybar horizontal swipe: gutters + horizontal pan on keys (before long-press reorder).
  useEffect(() => {
    const bar = keybarRef.current;
    if (!bar || keybarHidden) return;
    let lastX = 0;
    let tracking = false;
    let pointerId: number | null = null;
    let nativeTap:{key:string;startedAt:number;x:number;y:number;moved:boolean}|null=null;

    const keyButton = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLButtonElement>("button[data-key]") : null;

    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      const button=keyButton(event.target);
      if(button){event.preventDefault();try{button.setPointerCapture(event.pointerId);}catch{}const key=button.dataset.key!;touchKeyTap.current={key,dragged:false};const drag={key,timer:null as ReturnType<typeof setTimeout>|null,active:false,startX:event.clientX,startY:event.clientY,lastX:event.clientX,scrolling:false};drag.timer=setTimeout(()=>{if(drag.scrolling)return;drag.active=true;if(touchKeyTap.current)touchKeyTap.current.dragged=true;setDraggingKey(key);navigator.vibrate?.(20);},280);keyDrag.current=drag;return;}
      pointerId = event.pointerId;
      lastX = event.clientX;
      tracking = true;
    };
    const onMove = (event: PointerEvent) => {
      const drag=keyDrag.current;
      if(drag){if(!drag.active){const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;if(!drag.scrolling&&Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)*1.2){if(drag.timer)clearTimeout(drag.timer);drag.timer=null;drag.scrolling=true;if(touchKeyTap.current)touchKeyTap.current.dragged=true;}else if(!drag.scrolling)return;}if(drag.scrolling){event.preventDefault();const step=drag.lastX-event.clientX;drag.lastX=event.clientX;bar.scrollLeft+=step;return;}event.preventDefault();const buttons=Array.from(bar.querySelectorAll<HTMLButtonElement>("button[data-key]"));const target=buttons.find(button=>{const rect=button.getBoundingClientRect();return event.clientX>=rect.left&&event.clientX<=rect.right;});const targetKey=target?.dataset.key;if(!targetKey||targetKey===drag.key)return;const next=[...orderedKeys];const from=next.indexOf(drag.key),to=next.indexOf(targetKey);if(from<0||to<0)return;next.splice(from,1);next.splice(to,0,drag.key);onKeyOrderChange(next);return;}
      if (!tracking || event.pointerId !== pointerId || keyDrag.current?.active) return;
      const dx = lastX - event.clientX;
      lastX = event.clientX;
      if (Math.abs(dx) > 1) {
        bar.scrollLeft += dx;
        event.preventDefault();
      }
    };
    const onEnd = (event: PointerEvent) => {
      const drag=keyDrag.current;
      if(event.pointerType==="touch"&&drag){if(drag.timer)clearTimeout(drag.timer);if(drag.active||drag.scrolling){suppressKeyClick.current=true;setTimeout(()=>{suppressKeyClick.current=false;},0);}keyDrag.current=null;touchKeyTap.current=null;setDraggingKey(null);return;}
      if (event.pointerId !== pointerId) return;
      tracking = false;
      pointerId = null;
    };
    const onCancel = (event: PointerEvent) => {
      if(event.pointerType==="touch")cancelKeyDrag();
      tracking=false;pointerId=null;
    };
    const onClick = (event: MouseEvent) => {
      const button=keyButton(event.target);
      const key=button?.dataset.key;
      if(!key||suppressKeyClick.current)return;
      event.preventDefault();
      runShortcut(()=>runKey(key));
    };
    const onTouchEnd = (event: TouchEvent) => {
      const tap=nativeTap;nativeTap=null;if(!tap)return;
      const elapsed=performance.now()-tap.startedAt;
      if(tap.moved||elapsed>=280)return;
      event.preventDefault();suppressKeyClick.current=true;runShortcut(()=>runKey(tap.key));setTimeout(()=>{suppressKeyClick.current=false;},0);
    };
    const onTouchStart=(event:TouchEvent)=>{const button=keyButton(event.target);const touch=event.touches[0];if(!button||!touch)return;nativeTap={key:button.dataset.key!,startedAt:performance.now(),x:touch.clientX,y:touch.clientY,moved:false};};
    const onTouchMove=(event:TouchEvent)=>{const touch=event.touches[0];if(!nativeTap||!touch)return;if(Math.abs(touch.clientX-nativeTap.x)>8||Math.abs(touch.clientY-nativeTap.y)>8)nativeTap.moved=true;};

    bar.addEventListener("pointerdown", onDown, { passive: false });
    bar.addEventListener("pointermove", onMove, { passive: false });
    bar.addEventListener("pointerup", onEnd, { passive: true });
    bar.addEventListener("pointercancel", onCancel, { passive: true });
    bar.addEventListener("click", onClick);
    bar.addEventListener("touchstart", onTouchStart, {passive:true});
    bar.addEventListener("touchmove", onTouchMove, {passive:true});
    bar.addEventListener("touchend", onTouchEnd, { passive:false });
    return () => {
      bar.removeEventListener("pointerdown", onDown);
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onEnd);
      bar.removeEventListener("pointercancel", onCancel);
      bar.removeEventListener("click", onClick);
      bar.removeEventListener("touchstart", onTouchStart);
      bar.removeEventListener("touchmove", onTouchMove);
      bar.removeEventListener("touchend", onTouchEnd);
    };
  }, [keybarHidden, keyOrder.join("|")]);

  const runShortcut = (action: () => void) => {
    action();
  };

  const orderedKeys = [...keyOrder.filter((key) => DEFAULT_KEY_ORDER.includes(key)), ...DEFAULT_KEY_ORDER.filter((key) => !keyOrder.includes(key))];
  const runKey = (key: string) => {
    const data: Record<string,string>={esc:"\x1b",tab:"\t",enter:"\r",pipe:"|",tilde:"~",dash:"-",slash:"/",ctrlc:"\x03",ctrld:"\x04",ctrll:"\x0c"};
    const t=termRef.current;
    const cursor=(suffix:string)=>t?.modes.applicationCursorKeysMode?`\x1bO${suffix}`:`\x1b[${suffix}`;
    if(key==="up"){if(!t)return;if(t.buffer.active.type==="alternate")sendInput(cursor("A"));else scrollViewportLinesRef.current(-1);return;}
    if(key==="down"){if(!t)return;if(t.buffer.active.type==="alternate")sendInput(cursor("B"));else scrollViewportLinesRef.current(1);return;}
    if(key==="right"){if(t)sendInput(cursor("C"));return;}
    if(key==="left"){if(t)sendInput(cursor("D"));return;}
    if(data[key]) return sendInput(data[key]);
    if(key==="ctrl"){ctrlArmed.current=!ctrlArmed.current;setCtrlOn(ctrlArmed.current);return;}
    if(key==="hide"){onKeybarHiddenChange(true);return;}
    if(!t)return;
    if(key==="pgup"){if(t.buffer.active.type==="alternate")sendInput("\x1b[5~");else scrollViewportPagesRef.current(-1);}
    if(key==="pgdown"){if(t.buffer.active.type==="alternate")sendInput("\x1b[6~");else scrollViewportPagesRef.current(1);}
    if(key==="end"){followOutputRef.current=true;t.scrollToBottom();reportScrollLine();}
  };

  const beginKeyDrag=(key:string,event:React.PointerEvent<HTMLButtonElement>)=>{if(!event.isPrimary)return;event.preventDefault();if(event.pointerType==="touch")touchKeyTap.current={key,dragged:false};event.currentTarget.setPointerCapture(event.pointerId);const drag={key,timer:null as ReturnType<typeof setTimeout>|null,active:false,startX:event.clientX,startY:event.clientY,lastX:event.clientX,scrolling:false};drag.timer=setTimeout(()=>{if(drag.scrolling)return;drag.active=true;if(touchKeyTap.current)touchKeyTap.current.dragged=true;setDraggingKey(key);navigator.vibrate?.(20);},280);keyDrag.current=drag;};
  const moveKeyDrag=(event:React.PointerEvent<HTMLButtonElement>)=>{const drag=keyDrag.current;const bar=keybarRef.current;if(!drag||!bar)return;if(!drag.active){const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;if(!drag.scrolling&&Math.abs(dx)>10&&Math.abs(dx)>Math.abs(dy)*1.2){if(drag.timer)clearTimeout(drag.timer);drag.timer=null;drag.scrolling=true;if(touchKeyTap.current)touchKeyTap.current.dragged=true;}else if(!drag.scrolling)return;}if(drag.scrolling){event.preventDefault();const step=drag.lastX-event.clientX;drag.lastX=event.clientX;bar.scrollLeft+=step;return;}if(!drag.active)return;event.preventDefault();const barRect=bar.getBoundingClientRect();if(event.clientX<barRect.left+36)bar.scrollLeft-=18;else if(event.clientX>barRect.right-36)bar.scrollLeft+=18;const buttons=Array.from(bar.querySelectorAll<HTMLButtonElement>("button[data-key]"));const target=buttons.find((button)=>{const rect=button.getBoundingClientRect();return event.clientX>=rect.left&&event.clientX<=rect.right;});const targetKey=target?.dataset.key;if(!targetKey||targetKey===drag.key)return;const next=[...orderedKeys];const from=next.indexOf(drag.key),to=next.indexOf(targetKey);if(from<0||to<0)return;next.splice(from,1);next.splice(to,0,drag.key);onKeyOrderChange(next);};
  const endKeyDrag=(event:React.PointerEvent<HTMLButtonElement>)=>{const drag=keyDrag.current;if(!drag)return;if(drag.timer)clearTimeout(drag.timer);suppressKeyClick.current=true;if(event.pointerType==="touch"&&!drag.active&&!drag.scrolling)runShortcut(()=>runKey(drag.key));setTimeout(()=>{suppressKeyClick.current=false;},0);keyDrag.current=null;touchKeyTap.current=null;setDraggingKey(null);};
  const cancelKeyDrag=()=>{const drag=keyDrag.current;if(drag?.timer)clearTimeout(drag.timer);keyDrag.current=null;setDraggingKey(null);};
  const finishTouchKey=(event:React.TouchEvent<HTMLButtonElement>)=>{const tap=touchKeyTap.current;touchKeyTap.current=null;if(!tap||tap.dragged)return;event.preventDefault();suppressKeyClick.current=true;runShortcut(()=>runKey(tap.key));setTimeout(()=>{suppressKeyClick.current=false;},0);};

  const acquireWrite = async (force = false) => {
    try {
      await rpc(force ? "term:request-write" : "term:focus", { id: sessionId.current, force });
      setWriteLocked(false);
      termRef.current?.focus();
    } catch (error: any) {
      if (error?.code === "EWRITELOCK") setWriteLocked(true);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, position:"relative" }}>
      {/* xterm host — never unmounted by overlays */}
      <div
        ref={hostRef}
        className="terminal-screen"
        onClick={() => {
          termRef.current?.focus();
          if (!suppressTerminalClickScroll.current && followOutputRef.current) {
            focusLivePrompt({ forceLive: true });
          }
          void acquireWrite(false);
        }}
        style={{ flex: 1, minHeight: 90, padding: "3px 5px 3px 9px", background: terminalTheme.termHostBg, touchAction: "none", overflow: "hidden" }}
      />
      {sessionError && visible && <div role="alert" style={{position:"absolute",inset:"42% auto auto 50%",transform:"translate(-50%,-50%)",zIndex:47,maxWidth:"min(420px,calc(100% - 32px))",padding:"10px 12px",border:`1px solid ${terminalTheme.keybar.keyBorder}`,borderRadius:7,background:"rgba(24,24,29,.96)",color:terminalTheme.xterm.foreground,fontSize:12,lineHeight:1.5,textAlign:"center"}}>终端启动失败：{sessionError}</div>}
      {writeLocked && visible && <div style={{position:"absolute",top:10,right:10,zIndex:48,display:"flex",alignItems:"center",gap:7,padding:"7px 9px",border:"1px solid #6b5634",borderRadius:8,background:"rgba(39,32,22,.95)",color:"#d9b56c",fontSize:11}}>其他设备正在输入 <button style={{border:0,borderRadius:5,padding:"4px 7px",background:"#e0af68",color:"#17120a",fontSize:10}} onClick={()=>acquireWrite(true)}>接管输入</button></div>}

      {/* virtual key bar stays above the system keyboard; individual keys reorder by long-press drag */}
      {keybarHidden ? <div className="keybar" style={{display:"flex",justifyContent:"center",padding:"5px 7px calc(env(safe-area-inset-bottom) + 5px)",borderTop:`1px solid ${terminalTheme.keybar.border}`,background:terminalTheme.keybar.bg,flexShrink:0}}><button className="keybar-restore" style={{...keyStyles,minWidth:80}} onPointerDown={(event)=>event.preventDefault()} onClick={()=>onKeybarHiddenChange(false)}>⌨ 显示快捷键</button></div> : <div
        ref={keybarRef}
        className="keybar keybar-scroll"
        style={{
          background: terminalTheme.keybar.bg,
          display: "flex",
          gap: 5,
          overflowX: "auto",
          padding: "5px calc(env(safe-area-inset-right) + 7px) calc(env(safe-area-inset-bottom) + 5px)",
          borderTop: `1px solid ${terminalTheme.keybar.border}`,
          flexShrink: 0,
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none" as never,
          touchAction: "pan-x",
        }}
      >
        {orderedKeys.map((key)=><button key={key} data-key={key} data-dragging={draggingKey===key?"1":undefined} tabIndex={-1} style={{...keyStyles,minWidth:key==="enter"?44:keyStyles.minWidth,background:draggingKey===key?terminalTheme.keybar.drag:key==="ctrl"&&ctrlOn?terminalTheme.keybar.accent:keyStyles.background,color:draggingKey===key||key==="ctrl"&&ctrlOn?terminalTheme.keybar.accentText:keyStyles.color,cursor:draggingKey===key?"grabbing":"grab",transform:draggingKey===key?"scale(1.08)":"none",transition:"transform .12s, background .12s"}} onPointerUpCapture={endKeyDrag} onPointerCancel={cancelKeyDrag} onContextMenu={(event)=>event.preventDefault()} onMouseDown={(event)=>event.preventDefault()}>{KEY_LABELS[key]}</button>)}
      </div>}
    </div>
  );
}

// ── plumbing ────────────────────────────────────────────────────────────────

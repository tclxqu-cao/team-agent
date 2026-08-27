"use client";
// TerminalPane — xterm.js wired to the gateway. Always mounted (overlays sit
// above it so navigation never unmounts the terminal), handles mobile
// soft-keyboard resizing, touch scroll forwarding, and cwd reporting.

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { GatewayState } from "./useGateway";

const KEY_STYLES: React.CSSProperties = {
  minWidth: 34,
  height: 30,
  borderRadius: 7,
  border: "1px solid #2c2c36",
  background: "#17171e",
  color: "#ccc",
  fontSize: 11.5,
  padding: "0 7px",
  touchAction: "manipulation",
  userSelect: "none" as const,
  flexShrink: 0,
};

interface Props {
  state: GatewayState;
  rpc: <T = any,>(type: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  onEvent: (type: string, fn: (msg: any) => void) => () => void;
  /** TerminalPane registers (and clears) the binary output sink here */
  registerSink: (fn: ((data: Uint8Array) => void) | null) => void;
  /** called whenever the shell's working directory changes */
  onCwdChange?: (cwd: string | null) => void;
}

export default function TerminalPane({ state, rpc, onEvent, registerSink, onCwdChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const ctrlArmed = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  const sessionId = useRef<string | null>(null);
  const requestedSessionIdRef = useRef<string>(
    `t-web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const startRequestRef = useRef<Promise<{ sessionId: string; cwd?: string | null }> | null>(null);
  const followOutputRef = useRef(true);
  const lockedViewportYRef = useRef(0);

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
      theme: {
        background: "#101014",
        foreground: "#d8d8de",
        cursor: "#7aa2f7",
        selectionBackground: "#33467c",
        black: "#15151a", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
        blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
        brightBlack: "#414868", brightWhite: "#c0caf5",
      },
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
        const cwd = decodeURIComponent(url.pathname);
        if (cwd.startsWith("/")) onCwdChange?.(cwd);
        return true;
      } catch {
        return false;
      }
    });

    registerSink((bytes) => {
      // xterm advances its viewport while processing queued writes. When the
      // user is reading history, restore the explicitly locked line AFTER the
      // chunk has been parsed; checking before write is not sufficient.
      term.write(bytes, () => {
        if (followOutputRef.current) {
          term.scrollToBottom();
        } else {
          const maxLine = term.buffer.active.baseY;
          term.scrollToLine(Math.min(lockedViewportYRef.current, maxLine));
        }
      });
    });

    term.onData((data) => {
      if (!state.connected) return;
      // Typing a command intentionally returns to the live prompt.
      followOutputRef.current = true;
      term.scrollToBottom();
      if (ctrlArmed.current && data.length === 1) {
        const code = data.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) data = String.fromCharCode(code - 96);
        else if (data === " ") data = "\x00";
        else if (data === "[") data = "\x1b";
        else if (data === "\\") data = "\x1c";
        else if (data === "]") data = "\x1d";
        disarmCtrl();
      }
      rpc("term:input", { data }).catch(() => {});
    });

    let resizeTimer: ReturnType<typeof setTimeout>;
    term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      osc7.dispose();
      resizeTimer = setTimeout(() => {
        rpc("term:resize", { cols, rows }).catch(() => {});
      }, 120);
    });

    return () => {
      clearTimeout(resizeTimer);
      registerSink(null);
      onCwdChange?.(null);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disarmCtrl = () => {
    ctrlArmed.current = false;
    setCtrlOn(false);
  };

  const doFit = useCallback(() => {
    const fit = fitRef.current;
    if (!fit || !hostRef.current?.isConnected) return;
    try { fit.fit(); } catch {}
  }, []);

  // session handshake + cwd subscription
  useEffect(() => {
    if (!state.connected) return;
    let cancelled = false;
    doFit();
    requestAnimationFrame(doFit);
    // React StrictMode runs effects twice in development. Reuse one in-flight
    // start promise and one deterministic id, otherwise two shell prompts (or
    // a live prompt plus replay) are written on the very first connection.
    const start =
      startRequestRef.current ??=
        rpc<{ sessionId: string; cwd?: string | null }>("term:start", {
          id: sessionId.current ?? requestedSessionIdRef.current,
          cols: termRef.current?.cols ?? 80,
          rows: termRef.current?.rows ?? 24,
        });
    start
      .then((res) => {
        if (cancelled) return;
        sessionId.current = res.sessionId;
        setSessionReady(true);
        onCwdChange?.(res.cwd ?? null);
        setTimeout(doFit, 50);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.connected]);

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
    const syncViewport = () => {
      const height = vv?.height ?? window.innerHeight;
      const offsetTop = vv?.offsetTop ?? 0;
      document.documentElement.style.setProperty("--vv-height", `${Math.round(height)}px`);
      document.documentElement.style.setProperty("--vv-top", `${Math.round(offsetTop)}px`);
      requestAnimationFrame(() => {
        doFit();
        // Fit changes terminal rows; keep either live bottom or the user's
        // locked historical line after the mobile keyboard animates.
        const t = termRef.current;
        if (!t) return;
        if (followOutputRef.current) t.scrollToBottom();
        else t.scrollToLine(Math.min(lockedViewportYRef.current, t.buffer.active.baseY));
      });
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
      ro.disconnect();
      document.documentElement.style.removeProperty("--vv-height");
      document.documentElement.style.removeProperty("--vv-top");
    };
  }, [doFit]);

  // mobile touch scrolling: xterm 6 has NO built-in touch scrolling (its
  // Gesture class only feeds selection/zoom; nothing listens for scroll), and
  // synthetic wheels are ignored as untrusted. So we own the gesture:
  // single-finger vertical pan → scrollLines(). Text selection stays available
  // via long-press (system default). This matches Termius/blink shell UX.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const previousTouchAction = host.style.touchAction;
    host.style.touchAction = "none";
    let lastY = 0;
    let tracking = false;
    let acc = 0; // accumulated gesture pixels
    let pointerId: number | null = null;

    const begin = (y: number) => {
      lastY = y;
      acc = 0;
      tracking = true;
    };

    const move = (y: number, preventDefault: () => void) => {
      if (!tracking) return;
      const t = termRef.current;
      if (!t) return;
      const dy = lastY - y; // positive = swipe up = scroll down(later content)
      lastY = y;
      acc += dy;

      // Full-screen TUIs (OpenCode/Claude/Codex) use the alternate screen.
      // Alternate buffers have no xterm scrollback; send the PageUp/PageDown
      // keys the application itself understands. Physical PageUp was verified
      // against a long OpenCode session.
      if (t.buffer.active.type === "alternate") {
        const threshold = 48;
        const pages = Math.trunc(acc / threshold);
        if (pages !== 0) {
          acc -= pages * threshold;
          const sequence = pages < 0 ? "\x1b[5~" : "\x1b[6~";
          const count = Math.min(3, Math.abs(pages));
          rpc("term:input", { data: sequence.repeat(count) }).catch(() => {});
          preventDefault();
        } else if (Math.abs(dy) > 2) {
          preventDefault();
        }
        return;
      }

      const cellH = Math.max(12, (host.clientHeight / (t.rows || 24)) | 0);
      const lines = Math.trunc(acc / cellH);
      if (lines !== 0) {
        acc -= lines * cellH;
        followOutputRef.current = false;
        t.scrollLines(lines);
        lockedViewportYRef.current = t.buffer.active.viewportY;
        preventDefault(); // keep iOS page rubber-banding out
      } else if (Math.abs(dy) > 2) {
        preventDefault();
      }
    };

    const end = () => {
      tracking = false;
      pointerId = null;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !e.isPrimary) return;
      pointerId = e.pointerId;
      try { host.setPointerCapture(e.pointerId); } catch {}
      begin(e.clientY);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || e.pointerId !== pointerId) return;
      move(e.clientY, () => e.preventDefault());
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      try { host.releasePointerCapture(e.pointerId); } catch {}
      end();
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) begin(e.touches[0].clientY);
      else end();
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      move(e.touches[0].clientY, () => e.preventDefault());
    };

    const usePointer = "PointerEvent" in window;
    if (usePointer) {
      host.addEventListener("pointerdown", onPointerDown, { capture: true });
      host.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
      host.addEventListener("pointerup", onPointerEnd, { capture: true });
      host.addEventListener("pointercancel", onPointerEnd, { capture: true });
    } else {
      host.addEventListener("touchstart", onTouchStart, { passive: true });
      host.addEventListener("touchmove", onTouchMove, { passive: false });
      host.addEventListener("touchend", end, { passive: true });
      host.addEventListener("touchcancel", end, { passive: true });
    }
    return () => {
      host.style.touchAction = previousTouchAction;
      if (usePointer) {
        host.removeEventListener("pointerdown", onPointerDown, { capture: true });
        host.removeEventListener("pointermove", onPointerMove, { capture: true });
        host.removeEventListener("pointerup", onPointerEnd, { capture: true });
        host.removeEventListener("pointercancel", onPointerEnd, { capture: true });
      } else {
        host.removeEventListener("touchstart", onTouchStart);
        host.removeEventListener("touchmove", onTouchMove);
        host.removeEventListener("touchend", end);
        host.removeEventListener("touchcancel", end);
      }
    };
  }, []);

  const tapKey = (label: string, data: string) => (
    <button
      key={label}
      tabIndex={-1}
      style={KEY_STYLES}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => runShortcut(() => rpc("term:input", { data }).catch(() => {}))}
    >
      {label}
    </button>
  );

  const tapLocal = (label: string, action: () => void) => (
    <button
      key={label}
      tabIndex={-1}
      style={KEY_STYLES}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => runShortcut(action)}
    >
      {label}
    </button>
  );

  const runShortcut = (action: () => void) => {
    action();
    // Keep the hidden xterm textarea focused so the mobile keyboard remains
    // open. Closing the keyboard is always an explicit user action.
    requestAnimationFrame(() => termRef.current?.focus());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* xterm host — never unmounted by overlays */}
      <div
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        style={{ flex: 1, minHeight: 90, padding: "3px 5px 3px 9px", background: "#101014" }}
      />

      {/* virtual key bar — always visible */}
      <div
        className="keybar"
        style={{
          display: "flex",
          gap: 5,
          overflowX: "auto",
          padding: "5px calc(env(safe-area-inset-right) + 7px) calc(env(safe-area-inset-bottom) + 5px)",
          borderTop: "1px solid #1e1e26",
          flexShrink: 0,
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none" as never,
        }}
      >
        <button
          tabIndex={-1}
          style={{ ...KEY_STYLES, minWidth: 40, background: ctrlOn ? "#7aa2f7" : KEY_STYLES.background, color: ctrlOn ? "#0b0b10" : KEY_STYLES.color }}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            runShortcut(() => {
              ctrlArmed.current = !ctrlArmed.current;
              setCtrlOn(ctrlArmed.current);
            });
          }}
        >
          Ctrl
        </button>
        {tapKey("Esc", "\x1b")}
        {tapKey("Tab", "\t")}
        {tapKey("↑", "\x1b[A")}
        {tapKey("↓", "\x1b[B")}
        {tapKey("←", "\x1b[D")}
        {tapKey("→", "\x1b[C")}
        {tapLocal("Pg↑", () => {
          const t = termRef.current;
          if (!t) return;
          if (t.buffer.active.type === "alternate") {
            rpc("term:input", { data: "\x1b[5~" }).catch(() => {});
            return;
          }
          followOutputRef.current = false;
          t.scrollPages(-1);
          lockedViewportYRef.current = t.buffer.active.viewportY;
        })}
        {tapLocal("Pg↓", () => {
          const t = termRef.current;
          if (!t) return;
          if (t.buffer.active.type === "alternate") {
            rpc("term:input", { data: "\x1b[6~" }).catch(() => {});
            return;
          }
          t.scrollPages(1);
          const atBottom = t.buffer.active.viewportY >= t.buffer.active.baseY;
          followOutputRef.current = atBottom;
          lockedViewportYRef.current = t.buffer.active.viewportY;
        })}
        {tapLocal("End", () => {
          followOutputRef.current = true;
          termRef.current?.scrollToBottom();
        })}
        {tapKey("|", "|")}
        {tapKey("~", "~")}
        {tapKey("-", "-")}
        {tapKey("/", "/")}
        {tapKey("^C", "\x03")}
        {tapKey("^D", "\x04")}
        {tapKey("^L", "\x0c")}
      </div>
    </div>
  );
}

// ── plumbing ────────────────────────────────────────────────────────────────

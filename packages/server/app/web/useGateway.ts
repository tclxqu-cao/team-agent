"use client";
// useGateway — one WebSocket for everything: JSON request/response with
// correlation ids, binary frames fed to a callback, auto-reconnect, and
// terminal session restore after reconnect.
//
// Robustness contract (learned the hard way):
// - requests made before the socket is OPEN are QUEUED and flushed on open,
//   never silently dropped (StrictMode double-mount and slow dials are normal)
// - every connection gets a generation id; handlers of superseded sockets
//   become no-ops so stale opens/closes can't clobber current state

import { useCallback, useEffect, useRef, useState } from "react";

export interface FsEntry {
  name: string;
  dir: boolean;
  symlink: boolean;
  size: number;
  mtime: number;
}

export interface FsEvent {
  path: string;
  [k: string]: unknown;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type QueuedRequest = string;

export interface GatewayState {
  connected: boolean;
  needsToken: boolean;
  error: string | null;
}

const TOKEN_KEY = "agent-web-token";

function wsBaseUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export function useGateway(onBinary: (data: Uint8Array) => void) {
  const [state, setState] = useState<GatewayState>({ connected: false, needsToken: false, error: null });
  const [epoch, setEpoch] = useState(0); // bumps on every successful (re)connect
  const wsRef = useRef<WebSocket | null>(null);
  const genRef = useRef(0); // connection generation; superseded sockets no-op
  const pendingRef = useRef(new Map<number, Pending>());
  const queueRef = useRef<QueuedRequest[]>([]);
  const reqSeq = useRef(0);
  const listenersRef = useRef(new Map<string, Set<(msg: any) => void>>());
  const reconnectDelay = useRef(1000);
  const closedByUs = useRef(false);
  /** set when server rejected our token — blocks auto-reconnect until the
   *  user submits a new one */
  const awaitingNewToken = useRef(false);
  const binaryCb = useRef(onBinary);
  binaryCb.current = onBinary;

  const onEvent = useCallback((type: string, fn: (msg: any) => void) => {
    let set = listenersRef.current.get(type);
    if (!set) listenersRef.current.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }, []);

  const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
  const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t.trim());

  const sendOrQueue = useCallback((json: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(json);
      return;
    }
    queueRef.current.push(json);
  }, []);

  /** JSON request → promise of the :result message. Safe before/while connecting. */
  const rpc = useCallback(
    <T = any,>(type: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> => {
      return new Promise((resolve, reject) => {
        const id = ++reqSeq.current;
        const timer = setTimeout(() => {
          pendingRef.current.delete(id);
          reject(new Error(`${type} timeout`));
        }, timeoutMs);
        pendingRef.current.set(id, { resolve, reject, timer });
        sendOrQueue(JSON.stringify({ type, _req: id, ...params }));
      });
    },
    [sendOrQueue],
  );

  const connect = useCallback(() => {
    closedByUs.current = false;
    awaitingNewToken.current = false;
    const gen = ++genRef.current;
    // demote any previous socket to dead weight immediately
    const prev = wsRef.current;
    if (prev) {
      prev.onopen = prev.onmessage = prev.onerror = prev.onclose = null;
      try { prev.close(); } catch {}
    }

    const token = getToken();
    if (!token) {
      setState({ connected: false, needsToken: true, error: null });
      return;
    }
    awaitingNewToken.current = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsBaseUrl());
    } catch (err) {
      setState({ connected: false, needsToken: false, error: String(err) });
      return;
    }
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      if (gen !== genRef.current || wsRef.current !== ws) return;
      reconnectDelay.current = 1000;
      // authenticate FIRST — server holds all traffic until {type:"auth"} lands
      ws.send(JSON.stringify({ type: "auth", token }));
      const queued = queueRef.current;
      queueRef.current = [];
      for (const json of queued) ws.send(json);
    };

    ws.onmessage = (ev) => {
      if (gen !== genRef.current || wsRef.current !== ws) return;
      if (typeof ev.data === "string") {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "auth:result") {
          setState({ connected: true, needsToken: false, error: null });
          setEpoch((e) => e + 1);
          return;
        }
        if (msg.type === "error" && (msg.code === "EAUTH" || /token|unauthorized|401/i.test(msg.error ?? ""))) {
          localStorage.removeItem(TOKEN_KEY);
          awaitingNewToken.current = true;
          try { ws.close(4001, "invalid token"); } catch {}
          setState({ connected: false, needsToken: true, error: null });
          return;
        }
        if (msg.id != null && typeof msg.type === "string" && msg.type.endsWith(":result")) {
          const p = pendingRef.current.get(msg.id);
          if (p) {
            pendingRef.current.delete(msg.id);
            clearTimeout(p.timer);
            p.resolve(msg);
          }
          return;
        }
        listenersRef.current.get(msg.type)?.forEach((fn) => fn(msg));
      } else {
        binaryCb.current(new Uint8Array(ev.data));
      }
    };

    ws.onclose = (ev) => {
      if (gen !== genRef.current || wsRef.current !== ws) return; // superseded, ignore
      wsRef.current = null;
      // 4001 = server rejected our token. Stop reconnecting; the token gate
      // (needsToken) is the only way forward.
      if (ev.code === 4001) {
        localStorage.removeItem(TOKEN_KEY);
        awaitingNewToken.current = true;
        setState({ connected: false, needsToken: true, error: null });
        return;
      }
      if (closedByUs.current || awaitingNewToken.current) return;
      setState((s) => ({ ...s, connected: false }));
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, 8000);
      setTimeout(() => {
        if (!closedByUs.current && !awaitingNewToken.current && gen === genRef.current) connect();
      }, delay);
    };

    ws.onerror = () => {};
  }, []);

  useEffect(() => {
    connect();
    return () => {
      closedByUs.current = true;
      genRef.current++; // invalidate in-flight handlers synchronously
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        try { ws.close(); } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    /** increments each time a NEW connection actually opens — depend on this
     *  to (re)run startup handshakes after reconnects */
    epoch,
    rpc,
    onEvent,
    setTokenAndReconnect: (t: string) => {
      setToken(t);
      connect();
    },
  };
}

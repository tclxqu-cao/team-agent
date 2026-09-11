"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export interface FsEntry { name: string; dir: boolean; symlink: boolean; size: number; mtime: number }
export interface FsEvent { path: string; [key: string]: unknown }
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export interface GatewayState { connected: boolean; error: string | null }

function wsBaseUrl(): string { return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`; }

export function useGateway(onBinary: (data: Uint8Array) => void, getWsNonce: () => Promise<string>, onAuthLost: () => void) {
  const [state, setState] = useState<GatewayState>({ connected: false, error: null });
  const [epoch, setEpoch] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const generation = useRef(0);
  const pending = useRef(new Map<number, Pending>());
  const queue = useRef<string[]>([]);
  const requestId = useRef(0);
  const listeners = useRef(new Map<string, Set<(message: any) => void>>());
  const terminalListeners = useRef(new Map<number, Set<(data: Uint8Array, replay: boolean) => void>>());
  const terminalResetListeners = useRef(new Map<number, Set<() => void>>());
  const reconnectDelay = useRef(1000);
  const stopped = useRef(false);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const binaryHandler = useRef(onBinary);
  const nonceProvider = useRef(getWsNonce);
  const authLostHandler = useRef(onAuthLost);
  binaryHandler.current = onBinary;
  nonceProvider.current = getWsNonce;
  authLostHandler.current = onAuthLost;

  const onEvent = useCallback((type: string, handler: (message: any) => void) => {
    let set = listeners.current.get(type);
    if (!set) listeners.current.set(type, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }, []);

  const onTerminalData = useCallback((channelId: number, handler: (data: Uint8Array, replay: boolean) => void) => {
    let set = terminalListeners.current.get(channelId);
    if (!set) terminalListeners.current.set(channelId, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }, []);

  const onTerminalReset = useCallback((channelId: number, handler: () => void) => {
    let set = terminalResetListeners.current.get(channelId);
    if (!set) terminalResetListeners.current.set(channelId, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }, []);

  const sendTerminalInput = useCallback((channelId: number, data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const payload = new TextEncoder().encode(data);
    const frame = new Uint8Array(6 + payload.byteLength);
    const view = new DataView(frame.buffer);
    frame[0] = 1; frame[1] = 1; view.setUint32(2, channelId);
    frame.set(payload, 6); ws.send(frame); return true;
  }, []);

  const sendOrQueue = useCallback((json: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(json);
    else queue.current.push(json);
  }, []);

  const rpc = useCallback(<T = any,>(type: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> => new Promise((resolve, reject) => {
    const id = ++requestId.current;
    const timer = setTimeout(() => { pending.current.delete(id); reject(new Error(`${type} timeout`)); }, timeoutMs);
    pending.current.set(id, { resolve, reject, timer });
    sendOrQueue(JSON.stringify({ type, _req: id, ...params }));
  }), [sendOrQueue]);

  const connect = useCallback(async () => {
    stopped.current = false;
    const currentGeneration = ++generation.current;
    if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null; }
    const previous = wsRef.current;
    if (previous) { previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null; try { previous.close(); } catch {} }

    let nonce: string;
    try { nonce = await nonceProvider.current(); }
    catch { if (currentGeneration === generation.current) authLostHandler.current(); return; }
    if (currentGeneration !== generation.current || stopped.current) return;

    let ws: WebSocket;
    try { ws = new WebSocket(`${wsBaseUrl()}?nonce=${encodeURIComponent(nonce)}`); }
    catch (error) { setState({ connected: false, error: String(error) }); return; }
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      if (currentGeneration !== generation.current || wsRef.current !== ws) return;
      reconnectDelay.current = 1000;
      setState({ connected: true, error: null });
      setEpoch((value) => value + 1);
      const waiting = queue.current.splice(0);
      for (const json of waiting) ws.send(json);
      // Mobile browsers (iOS Safari) silently suspend pages and leave the TCP
      // socket half-dead: readyState stays OPEN while data never arrives, so
      // typed characters vanish and onclose never fires. Ping on an interval
      // and force-close on missing liveness so the reconnect flow takes over.
      let lastAlive = Date.now();
      heartbeat.current = setInterval(() => {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) { clearInterval(heartbeat.current!); heartbeat.current = null; return; }
        if (Date.now() - lastAlive > 25000) { try { ws.close(); } catch {} return; }
        try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
      }, 10000);
      const markAlive = () => { lastAlive = Date.now(); };
      ws.addEventListener("message", markAlive);
      ws.addEventListener("close", () => ws.removeEventListener("message", markAlive), { once: true });
    };
    ws.onmessage = (event) => {
      if (currentGeneration !== generation.current || wsRef.current !== ws) return;
      if (typeof event.data !== "string") {
        const frame = new Uint8Array(event.data);
        // Opcode 4 belongs to live-view JPEG frames; terminal replay uses 6.
        if (frame.byteLength >= 6 && frame[0] === 1 && (frame[1] === 2 || frame[1] === 6)) {
          const channelId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2);
          terminalListeners.current.get(channelId)?.forEach((handler) => handler(frame.subarray(6), frame[1] === 6));
        } else if (frame.byteLength >= 6 && frame[0] === 1 && frame[1] === 3) {
          // server reset marker: a scrollback replay follows, so the pane must
          // clear its (possibly still populated) buffer first
          const channelId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2);
          terminalResetListeners.current.get(channelId)?.forEach((handler) => handler());
        } else binaryHandler.current(frame);
        return;
      }
      let message: any;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "error" && message.id != null) {
        const request = pending.current.get(message.id);
        if (request) { pending.current.delete(message.id); clearTimeout(request.timer); const error = Object.assign(new Error(message.error || "gateway error"), { code: message.code }); request.reject(error); }
        return;
      }
      if (message.id != null && typeof message.type === "string" && message.type.endsWith(":result")) {
        const request = pending.current.get(message.id);
        if (request) { pending.current.delete(message.id); clearTimeout(request.timer); request.resolve(message); }
        return;
      }
      listeners.current.get(message.type)?.forEach((handler) => handler(message));
    };
    ws.onclose = (event) => {
      if (currentGeneration !== generation.current || wsRef.current !== ws) return;
      if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null; }
      wsRef.current = null;
      setState({ connected: false, error: null });
      if (event.code === 4001 || event.code === 4003) { authLostHandler.current(); return; }
      if (stopped.current) return;
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, 8000);
      setTimeout(() => { if (!stopped.current && currentGeneration === generation.current) connect(); }, delay);
    };
    ws.onerror = () => {};
  }, []);

  useEffect(() => {
    connect();
    return () => { stopped.current = true; generation.current++; if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null; } const ws = wsRef.current; wsRef.current = null; if (ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; try { ws.close(); } catch {} } };
  }, [connect]);

  return { state, epoch, rpc, onEvent, onTerminalData, onTerminalReset, sendTerminalInput, reconnect: connect };
}

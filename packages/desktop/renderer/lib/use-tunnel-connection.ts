import { useEffect, useRef, useState } from "react";
import type { TunnelStatus } from "../../../server/lib/tunnel-control.mjs";

export interface TunnelApi {
  tunnelStatus(): Promise<TunnelStatus>;
  connectTunnel(): Promise<TunnelStatus>;
}

export function useTunnelConnection(api: TunnelApi, options: { origin?: string; busy: boolean; onAddressChanged(): void }) {
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [failure, setFailure] = useState("");
  const [requesting, setRequesting] = useState(false);
  const latest = useRef(options); latest.current = options;
  const requestedOrigin = useRef<string>();
  const connecting = useRef(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const apply = (value: TunnelStatus) => {
    setStatus(value); setFailure("");
    if (!value.accessUrl || value.phase === "unsupported") return;
    const origin = new URL(value.accessUrl).origin;
    if (origin === latest.current.origin) requestedOrigin.current = origin;
    else if (!latest.current.busy && requestedOrigin.current !== origin && (value.mode !== "local" || latest.current.origin)) {
      requestedOrigin.current = origin;
      latest.current.onAddressChanged();
    }
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = revision.current;
      try {
        const value = await api.tunnelStatus();
        if (active && !connecting.current && version === revision.current) apply(value);
      } catch { if (active && !connecting.current && version === revision.current) setFailure("无法读取公网连接状态，请检查后台服务。"); }
      if (active) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { active = false; mounted.current = false; clearTimeout(timer); };
  }, [api]);
  const connect = async () => {
    if (connecting.current || status?.phase === "connecting" || status?.phase === "ready" || status?.phase === "unsupported") return;
    connecting.current = true; revision.current++; setRequesting(true); setFailure("");
    try { const value = await api.connectTunnel(); if (mounted.current) apply(value); }
    catch { if (mounted.current) setFailure("无法发起公网连接，请检查后台服务后重试。"); }
    finally { revision.current++; connecting.current = false; if (mounted.current) setRequesting(false); }
  };
  return { status, failure, requesting, connect };
}

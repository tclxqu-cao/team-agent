import React, { useEffect, useState } from "react";
import { Globe, LoaderCircle } from "lucide-react";
import type { PairingRoute } from "../../../shared/src/contracts/tunnel-status";
import type { useTunnelConnection } from "../lib/use-tunnel-connection";
import "./tunnel-connection.css";

const routeLabels: Record<PairingRoute["kind"], string> = {
  "self-hosted": "自建 HTTPS", cloudflare: "Cloudflare", lan: "局域网", tailscale: "Tailscale / 组网 IP", vpn: "本机网络 IP", headscale: "自建 Headscale",
};

export function PairingRoutePicker({ api, value, busy, onChange }: {
  api: { pairingRoutes(): Promise<PairingRoute[]> };
  value: string;
  busy: boolean;
  onChange(value: string): void;
}) {
  const [routes, setRoutes] = useState<PairingRoute[]>([]);
  useEffect(() => {
    if (busy) return;
    let active = true;
    const load = () => { void api.pairingRoutes().then(choices => { if (active) setRoutes(choices); }, () => {}); };
    load();
    window.addEventListener("focus", load);
    return () => { active = false; window.removeEventListener("focus", load); };
  }, [api, busy]);
  const selected = routes.find(route => route.id === value);
  if (!routes.length && !value) return null;
  const needsNetwork = selected && !["self-hosted", "cloudflare"].includes(selected.kind);
  return <label className="pairing-route-picker">
    <span>扫码连接方式</span>
    <select value={value} disabled={busy} onChange={event => onChange(event.target.value)}>
      <option value="">默认连接</option>
      {value && !selected && <option value={value}>当前地址已不可用</option>}
      {routes.map(route => <option key={route.id} value={route.id}>{routeLabels[route.kind]}{route.address ? ` · ${route.address}` : ""}{route.interfaceName ? ` (${route.interfaceName})` : ""}</option>)}
    </select>
    {needsNetwork && <small>手机需要能访问所选地址。使用 VPN 时，手机也需要接入对应组网。</small>}
  </label>;
}

export function TunnelConnectionControl({ connection }: { connection: ReturnType<typeof useTunnelConnection> }) {
  const { status, failure, requesting, connect } = connection;
  const busy = requesting || status?.phase === "connecting";
  const ready = status?.mode === "public" && status.phase === "ready";
  const label = busy ? "正在连接公网" : ready ? "公网已连接" : status?.phase === "unsupported" ? "公网控制不可用" : status?.mode === "lan" ? "仅局域网" : status ? "仅本机" : "正在读取连接状态";
  return <section className="tunnel-connection" aria-label="公网连接">
    <div className="tunnel-connection-heading"><span role="status" className={ready ? "tunnel-connected" : ""}>{busy ? <LoaderCircle size={15} className="tunnel-spin" aria-hidden="true" /> : <Globe size={15} aria-hidden="true" />}{label}</span>
      {!ready && <button type="button" disabled={!status || busy || status.phase === "unsupported"} onClick={() => void connect()}>{busy ? "连接中…" : status?.phase === "error" || failure ? "重试连接" : "开启公网连接"}</button>}
    </div>
    {busy && <p>{status?.stage === "checking" ? "正在检查公网地址是否可用…" : "正在建立公网隧道，最多等待 30 秒…"}</p>}
    {(failure || status?.error) && <p role="alert">{failure || status?.error}</p>}
    {!busy && !ready && status?.mode === "lan" && <p>当前二维码仅支持同一网络，请让手机与电脑连接同一 Wi-Fi。</p>}
    {!busy && !ready && status?.mode === "local" && status.phase !== "unsupported" && <p>当前地址仅限这台电脑访问，请开启公网连接或连接可用的局域网。</p>}
  </section>;
}

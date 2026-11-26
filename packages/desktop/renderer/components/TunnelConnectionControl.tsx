import React, { useEffect, useState } from "react";
import { Globe, LoaderCircle } from "lucide-react";
import type { PairingRoute } from "../../../shared/src/contracts/tunnel-status";
import type { useTunnelConnection } from "../lib/use-tunnel-connection";
import { pairingRouteOptions } from "../lib/pairing-route-options";
import "./tunnel-connection.css";

export function PairingRoutePicker({ api, value, busy, onChange }: {
  api: { pairingRoutes(): Promise<PairingRoute[]> };
  value: string;
  busy: boolean;
  onChange(value: string): void;
}) {
  const [routes, setRoutes] = useState<PairingRoute[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [pickedKey, setPickedKey] = useState("");
  useEffect(() => {
    if (busy) return;
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      setStatus("loading");
      try {
        const choices = await api.pairingRoutes();
        if (active) { setRoutes(choices); setStatus("ready"); }
      } catch {
        if (active) { setRoutes([]); setStatus("error"); }
      } finally { pending = false; }
    };
    void load();
    window.addEventListener("focus", load);
    return () => { active = false; window.removeEventListener("focus", load); };
  }, [api, busy, attempt]);
  const loading = busy || status === "loading";
  const missing = loading ? "正在读取" : status === "error" ? "线路未知" : "后台未提供";
  const options = pairingRouteOptions(routes, missing);
  const selected = options.find(o => o.key === pickedKey && o.route?.id === value) ?? options.find(o => o.route?.id === value);
  const needsNetwork = selected?.route && !["self-hosted", "cloudflare"].includes(selected.route.kind);
  return <div className="pairing-route-picker">
    <label>
      <span>扫码连接方式</span>
      <select value={selected?.key ?? value} onChange={event => {
        const key = event.target.value;
        const routeId = options.find(option => option.key === key)?.route?.id ?? "";
        setPickedKey(key);
        if (routeId !== value) onChange(routeId);
      }}>
        <option value="">默认连接</option>
        {value && !selected && <option value={value} disabled>当前所选线路 · {missing}</option>}
        {options.map(option => <option key={option.key} value={option.key} disabled={!option.route || busy}>{option.label}</option>)}
      </select>
    </label>
    {!busy && status !== "loading" && !routes.length && <small role="status">{status === "error"
      ? "无法读取后台线路，请检查 AgentRoam 后台后重试。"
      : "后台未返回可选线路。连接网络或 VPN 后可重新读取。"}</small>}
    <button type="button" className="pairing-route-refresh" disabled={loading} onClick={() => setAttempt(n => n + 1)}>刷新线路</button>
    {needsNetwork && <small>手机需要能访问所选地址。使用 VPN 时，手机也需要接入对应组网。</small>}
  </div>;
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

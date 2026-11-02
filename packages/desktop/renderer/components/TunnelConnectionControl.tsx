import React from "react";
import { Globe, LoaderCircle } from "lucide-react";
import type { useTunnelConnection } from "../lib/use-tunnel-connection";
import "./tunnel-connection.css";

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

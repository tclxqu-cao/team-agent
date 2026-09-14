import DesktopPermissionDialog from "./components/DesktopPermissionDialog";
import React, { useEffect, useState } from "react";
import { createSharedAgentApi, type SharedServiceStatus } from "./lib/shared-service";

window.agentApi = createSharedAgentApi(window.sharedServiceApi, window.desktopDeviceApi);

export function SharedServiceRoot() {
  const [status, setStatus] = useState<SharedServiceStatus | null>(null);
  const [showPermissions, setShowPermissions] = useState(false);
  useEffect(() => {
    let active = true;
    void window.agentApi.desktopLiveSetup().then(({ supported, needsSetup, status }) => {
      if (active && supported && (needsSetup || (status.enabled && (status.permissionScreen !== "granted" || status.accessibilityTrusted !== true)))) setShowPermissions(true);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const [failure, setFailure] = useState("");
  const [App, setApp] = useState<React.ComponentType | null>(null);
  useEffect(() => {
    let closed = false;
    const refresh = async () => {
      try { const value = await window.sharedServiceApi.status(); if (!closed) { setStatus(value); setFailure(""); } }
      catch (error) { if (!closed) setFailure(error instanceof Error ? error.message : "连接失败"); }
    };
    void refresh(); const timer = setInterval(refresh, 3000);
    window.addEventListener("shared-service:offline", refresh);
    return () => { closed = true; clearInterval(timer); window.removeEventListener("shared-service:offline", refresh); };
  }, []);
  useEffect(() => {
    if (status?.connected && !App) void import("./App").then((module) => setApp(() => module.default));
  }, [status?.connected, App]);
  const select = async (id: string) => {
    try { await window.sharedServiceApi.select(id); window.location.reload(); }
    catch (error) { setFailure(error instanceof Error ? error.message : "连接失败"); }
  };
  const connected = status?.connected && !failure;
  return <>
    {showPermissions && <DesktopPermissionDialog onClose={() => setShowPermissions(false)} />}
    {App && <App />}
    {!connected && <div style={{ position: "fixed", inset: 0, zIndex: 10000, display: "grid", placeItems: "center", background: "var(--bg-primary, #17191d)", color: "var(--text-primary, #eee)" }}>
      <section style={{ width: 560, maxWidth: "85vw", padding: 32 }}>
        <h2>{App ? "统一服务连接已断开" : "连接 AgentRoam 服务"}</h2>
        <p>{App ? "正在重连。后端任务继续由服务管理，当前输入保留。" : "请先启动 agentroam。桌面和网页连接同一服务后，共享项目、设置和会话。"}</p>
        {status?.preferredDataDir && <p>上次使用：{status.preferredDataDir}</p>}
        {status?.choices.map((choice) => <button key={choice.instanceId} onClick={() => void select(choice.instanceId)} style={{ display: "block", width: "100%", marginTop: 12, padding: 14, textAlign: "left" }}>
          连接 {choice.url}<br /><small>{choice.dataDir}</small>
        </button>)}
        {failure && <p role="alert">{failure}</p>}
      </section>
    </div>}
  </>;
}

import DesktopPermissionDialog from "./components/DesktopPermissionDialog";
import React, { useEffect, useRef, useState } from "react";
import { createSharedAgentApi, type SharedServiceStatus } from "./lib/shared-service";
import { isDesktopLiveSetupPending } from "./lib/desktop-live-setup";

window.agentApi = createSharedAgentApi(window.sharedServiceApi, window.desktopDeviceApi);

export function SharedServiceRoot() {
  const [status, setStatus] = useState<SharedServiceStatus | null>(null);
  const [showPermissions, setShowPermissions] = useState(false);
  const permissionsDismissedRef = useRef(false);
  useEffect(() => {
    if (permissionsDismissedRef.current) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The CLI service may still be starting when the desktop launches; retry
    // until it answers so the authorization dialog can pop at startup.
    const check = async () => {
      try {
        const info = await window.agentApi.desktopLiveSetup();
        if (!active || permissionsDismissedRef.current) return;
        if (isDesktopLiveSetupPending(info)) setShowPermissions(true);
      } catch {
        if (active && !permissionsDismissedRef.current) timer = setTimeout(() => void check(), 3000);
      }
    };
    void check();
    return () => { active = false; if (timer) clearTimeout(timer); };
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
    {showPermissions && <DesktopPermissionDialog onClose={() => { permissionsDismissedRef.current = true; setShowPermissions(false); }} />}
    {App && <App />}
    {!connected && <div className="service-gate">
      <section className="service-gate-card">
        <h2>{App ? "统一服务连接已断开" : "连接 AgentRoam 服务"}</h2>
        <p className="service-gate-desc">{App ? "正在重连。后端任务继续由服务管理，当前输入保留。" : "请先启动 agentroam。桌面和网页连接同一服务后，共享项目、设置和会话。"}</p>
        {status?.preferredDataDir && <p className="service-gate-meta">上次使用：{status.preferredDataDir}</p>}
        {status?.choices.map((choice) => <button key={choice.instanceId} type="button" className="service-gate-choice" onClick={() => void select(choice.instanceId)}>
          <span>连接 {choice.url}</span>
          <small>{choice.dataDir}</small>
        </button>)}
        {failure && <p role="alert" className="service-gate-error">{failure}</p>}
      </section>
    </div>}
  </>;
}

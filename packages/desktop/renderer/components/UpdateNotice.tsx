import { useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import type { UpdateStatus } from "../global";

const ACTIVE_PHASES = new Set<UpdateStatus["phase"]>(["downloading", "installing", "reconnecting"]);
const POLL_PHASES = new Set<UpdateStatus["phase"]>(["checking", ...ACTIVE_PHASES]);
const FIRST_CHECK_MIN_MS = 6_000;
const FIRST_CHECK_JITTER_MS = 24_000;

export default function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState(() => sessionStorage.getItem("agentroam.dismissed-update"));

  useEffect(() => {
    let mounted = true;
    const api = window.agentApi;
    const unsubscribe = api.onUpdateStatus?.((next) => { if (mounted) setStatus(next); }) ?? (() => undefined);
    void api.getUpdateStatus().then((next) => { if (mounted) setStatus(next); }).catch(() => undefined);
    const checkTimer = window.setTimeout(() => {
      void api.checkForUpdate().then((next) => { if (mounted) setStatus(next); }).catch(() => undefined);
    }, FIRST_CHECK_MIN_MS + Math.floor(Math.random() * (FIRST_CHECK_JITTER_MS + 1)));
    return () => {
      mounted = false;
      window.clearTimeout(checkTimer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!status || !POLL_PHASES.has(status.phase)) return;
    const timer = window.setInterval(() => {
      void window.agentApi.getUpdateStatus().then(setStatus).catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [status?.phase]);

  if (!status || ["idle", "checking", "up-to-date", "unavailable"].includes(status.phase)) return null;
  if (status.phase === "available" && status.targetVersion === dismissedVersion) return null;

  const active = ACTIVE_PHASES.has(status.phase);
  const failed = status.phase === "failed";
  const complete = status.phase === "complete";
  const label = active
    ? status.phase === "downloading" ? `正在下载${status.progress !== undefined ? ` ${status.progress}%` : ""}` : status.phase === "installing" ? "正在安装" : "正在重连"
    : failed ? "更新失败，重试"
      : complete ? (status.message ?? "更新已就绪")
        : `发现 AgentRoam ${status.targetVersion}`;

  const install = async () => {
    try { setStatus(await window.agentApi.installUpdate()); }
    catch (error) { setStatus({ ...status, phase: "failed", message: error instanceof Error ? error.message : "更新失败" }); }
  };

  const dismiss = () => {
    if (!status.targetVersion) return;
    sessionStorage.setItem("agentroam.dismissed-update", status.targetVersion);
    setDismissedVersion(status.targetVersion);
  };

  return (
    <aside className={`update-notice${failed ? " update-notice--failed" : ""}`} aria-live="polite">
      <div className="update-notice__content">
        <strong>{label}</strong>
        {!active && !complete && <span>点击后才会下载安装文件</span>}
        {failed && status.message && <span>{status.message}</span>}
      </div>
      {!active && !complete && (
        <button className="update-notice__action" type="button" onClick={() => void install()} title={failed ? "重试更新" : "下载更新"}>
          {failed ? <RefreshCw size={16} /> : <Download size={16} />}
          <span>{failed ? "重试" : "更新"}</span>
        </button>
      )}
      {!active && (
        <button className="update-notice__close" type="button" onClick={dismiss} title="关闭更新提醒" aria-label="关闭更新提醒"><X size={16} /></button>
      )}
    </aside>
  );
}

import { useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import type { AgentApi, UpdateStatus } from "../../../shared/src/contracts/agent-api";
import { UPDATE_CHECK_INTERVAL_MS } from "../../../core/src/domain/update/update-checker";
import "./UpdateNotice.css";

const ACTIVE_PHASES = new Set<UpdateStatus["phase"]>(["downloading", "installing", "reconnecting"]);
const POLL_PHASES = new Set<UpdateStatus["phase"]>(["checking", ...ACTIVE_PHASES]);
const FIRST_CHECK_MIN_MS = 6_000;
const FIRST_CHECK_JITTER_MS = 24_000;

export type UpdateNoticeApi = Pick<AgentApi, "getUpdateStatus" | "checkForUpdate" | "installUpdate" | "onUpdateStatus">;

export default function UpdateNotice({
  api,
  product = "AgentRoam",
  scope = "desktop",
  inline = false,
  hint = "安装后将重新打开应用",
}: { api: UpdateNoticeApi; product?: string; scope?: string; inline?: boolean; hint?: string }) {
  const storageKey = `agentroam.dismissed-update.${scope}`;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState(() => sessionStorage.getItem(storageKey));

  useEffect(() => {
    let mounted = true;
    const receive = (next: UpdateStatus) => { if (mounted) setStatus(next); };
    const unsubscribe = api.onUpdateStatus?.(receive);
    void api.getUpdateStatus().then(receive).catch(() => undefined);
    const check = () => api.checkForUpdate().then(receive).catch(() => undefined);
    const checkPeriodically = async () => {
      await check();
      if (mounted) checkTimer = window.setTimeout(checkPeriodically, UPDATE_CHECK_INTERVAL_MS);
    };
    let checkTimer = window.setTimeout(checkPeriodically, FIRST_CHECK_MIN_MS + Math.floor(Math.random() * (FIRST_CHECK_JITTER_MS + 1)));
    const checkOnResume = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", checkOnResume);
    return () => {
      mounted = false;
      window.clearTimeout(checkTimer);
      document.removeEventListener("visibilitychange", checkOnResume);
      unsubscribe?.();
    };
  }, [api]);

  useEffect(() => {
    const tracking = status && POLL_PHASES.has(status.phase);
    if (!tracking && scope !== "cli") return;
    const timer = window.setInterval(() => {
      if (tracking || document.visibilityState === "visible") void api.getUpdateStatus().then(setStatus).catch(() => undefined);
    }, tracking ? 1_500 : 30_000);
    return () => window.clearInterval(timer);
  }, [api, scope, status?.phase]);

  if (!status || ["idle", "checking", "up-to-date", "unavailable"].includes(status.phase)) return null;
  const active = ACTIVE_PHASES.has(status.phase);
  if (!active && status.targetVersion === dismissedVersion) return null;
  const failed = status.phase === "failed";
  const complete = status.phase === "complete";
  const label = active
    ? status.message ?? (status.phase === "downloading" ? `正在下载${status.progress !== undefined ? ` ${status.progress}%` : ""}` : status.phase === "installing" ? "正在安装" : "正在重连")
    : failed ? "更新失败，重试"
      : complete ? (status.message ?? "更新已就绪")
        : `${product} ${status.targetVersion} 可更新`;

  const install = async () => {
    try { setStatus(await api.installUpdate()); }
    catch (error) { setStatus({ ...status, phase: "failed", message: error instanceof Error ? error.message : "更新失败" }); }
  };

  const dismiss = () => {
    if (!status.targetVersion) return;
    sessionStorage.setItem(storageKey, status.targetVersion);
    setDismissedVersion(status.targetVersion);
  };

  return (
    <aside className={`update-notice${failed ? " update-notice--failed" : ""}${inline ? " update-notice--inline" : ""}`} aria-live="polite">
      <div className="update-notice__content">
        <strong>{label}</strong>
        {status.phase === "available" && hint && <span>{hint}</span>}
        {failed && status.message && <span>{status.message}</span>}
      </div>
      {!active && !complete && (
        <button className="update-notice__action" type="button" onClick={() => void install()} title={failed ? "重试更新" : "安装更新"}>
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

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, LoaderCircle } from "lucide-react";
import type { AgentApi, UpdateStatus } from "../../../shared/src/contracts/agent-api";
import { compareAgentRoamVersions, parseAgentRoamVersion } from "../../../core/src/domain/update/update-release";
import "./UpdateNotice.css";

const ACTIVE_PHASES = new Set<UpdateStatus["phase"]>(["downloading", "installing", "reconnecting"]);
const POLL_PHASES = new Set<UpdateStatus["phase"]>(["checking", ...ACTIVE_PHASES]);
const AVAILABLE_PHASES = new Set<UpdateStatus["phase"]>(["available", "failed"]);
const OFFER_PHASES = new Set<UpdateStatus["phase"]>(["available", "failed", "complete"]);
const UpdateCheckContext = createContext<{ checking: boolean; disabled: boolean; available: boolean; check(): void } | null>(null);

export type UpdateNoticeApi = Pick<AgentApi, "getUpdateStatus" | "checkForUpdate" | "installUpdate" | "onUpdateStatus">;

export function UpdateCheckButton({
  iconOnly = false,
  className = iconOnly ? "file-drawer-toggle" : "",
}: { iconOnly?: boolean; className?: string }) {
  const update = useContext(UpdateCheckContext);
  if (!update) return null;
  const label = update.checking ? "正在检查更新" : update.available ? "有可用更新，检查更新" : "检查更新";
  const Icon = update.checking ? LoaderCircle : Download;
  return <button type="button" className={`update-check-button ${className}`.trim()}
    data-pairing-action data-update-available={update.available || undefined}
    title={label} aria-label={label} aria-busy={update.checking} disabled={update.disabled} onClick={update.check}>
    <Icon size={16} aria-hidden="true" />
    {!iconOnly && (update.available && !update.checking ? "有新版本" : label)}
  </button>;
}

export default function UpdateNotice({
  api,
  product = "AgentRoam",
  scope = "desktop",
  hint = "安装后将重新打开应用",
  installLabel = "安装更新",
  enabled = true,
  children,
}: { api: UpdateNoticeApi; product?: string; scope?: string; hint?: string; installLabel?: string; enabled?: boolean; children?: ReactNode }) {
  const storageKey = `agentroam.dismissed-update.${scope}`;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState(() => typeof window === "undefined" ? null : sessionStorage.getItem(storageKey));
  const [manual, setManual] = useState<"requesting" | "waiting" | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const receive = useCallback((next: UpdateStatus) => {
    setRefreshing(next.phase === "checking");
    setStatus(current => {
      if (next.phase === "checking" && current?.targetVersion && OFFER_PHASES.has(current.phase)
        && (!next.targetVersion || current.targetVersion === next.targetVersion)) return current;
      if (scope === "cli" && current?.targetVersion && (ACTIVE_PHASES.has(current.phase) || current.phase === "complete")
        && ["idle", "checking", "up-to-date"].includes(next.phase)) {
        if (parseAgentRoamVersion(next.currentVersion) && parseAgentRoamVersion(current.targetVersion)
          && compareAgentRoamVersions(next.currentVersion, current.targetVersion) >= 0) {
          return { phase: "complete", currentVersion: next.currentVersion, targetVersion: current.targetVersion, message: `电脑已更新到 ${next.currentVersion}。` };
        }
        return current;
      }
      return next;
    });
  }, [scope]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let revision = 0;
    const unsubscribe = api.onUpdateStatus?.(next => { revision++; receive(next); });
    const readStatus = () => {
      const requestRevision = ++revision;
      void api.getUpdateStatus().then(next => { if (live && revision === requestRevision) receive(next); }).catch(() => undefined);
    };
    readStatus();
    const readOnResume = () => { if (document.visibilityState === "visible") readStatus(); };
    document.addEventListener("visibilitychange", readOnResume);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", readOnResume);
      unsubscribe?.();
    };
  }, [api, enabled, receive]);

  const finishCheck = useCallback((next: UpdateStatus) => {
    receive(next);
    setManual(null);
    if (next.targetVersion && OFFER_PHASES.has(next.phase)) {
      setDismissedVersion(null);
      return;
    }
    if (next.phase === "up-to-date") setFeedback(next.message ?? `当前已是最新版本 ${next.currentVersion}。`);
    else if (next.phase === "unavailable" || next.phase === "idle" || next.phase === "failed") {
      setFeedback(next.message ?? "当前无法检查更新。");
    }
  }, [receive]);

  useEffect(() => {
    const waiting = manual === "waiting";
    const tracking = waiting || (status && POLL_PHASES.has(status.phase));
    if (!enabled || (!tracking && scope !== "cli") || manual === "requesting") return;
    let live = true;
    let timer: number;
    const deadline = Date.now() + 15_000;
    const interval = tracking ? 1_500 : 30_000;
    const poll = async () => {
      try {
        if (tracking || document.visibilityState === "visible") {
          const next = await api.getUpdateStatus();
          if (!live) return;
          if (waiting && next.phase !== "checking") return finishCheck(next);
          receive(next);
        }
      } catch {}
      if (!live) return;
      if (waiting && Date.now() >= deadline) {
        setManual(null);
        setFeedback("检查更新超时，请稍后重试。");
        return;
      }
      timer = window.setTimeout(poll, interval);
    };
    timer = window.setTimeout(poll, interval);
    return () => { live = false; window.clearTimeout(timer); };
  }, [api, enabled, finishCheck, manual, receive, scope, status?.phase]);

  const check = async () => {
    setFeedback(null);
    setManual("requesting");
    try {
      const next = await api.checkForUpdate();
      if (next.phase === "checking") {
        receive(next);
        setManual("waiting");
      } else finishCheck(next);
    } catch {
      setManual(null);
      setFeedback("检查更新失败，请稍后重试。");
    }
  };

  const dismissVersion = (version: string) => {
    sessionStorage.setItem(storageKey, version);
    setDismissedVersion(version);
  };

  const dismiss = () => {
    if (feedback) { setFeedback(null); return; }
    if (status?.targetVersion) dismissVersion(status.targetVersion);
  };

  const install = async () => {
    if (!status || installing) return;
    setInstalling(true);
    try {
      const next = await api.installUpdate();
      receive(next);
      if (next.phase === "available" && next.targetVersion) dismissVersion(next.targetVersion);
    } catch (error) {
      receive({ ...status, phase: "failed", message: error instanceof Error ? error.message : "更新失败" });
    } finally { setInstalling(false); }
  };

  const active = status && ACTIVE_PHASES.has(status.phase);
  const available = Boolean(status?.targetVersion && AVAILABLE_PHASES.has(status.phase));
  const offer = status?.targetVersion && OFFER_PHASES.has(status.phase) && status.targetVersion !== dismissedVersion ? status : null;
  const canInstall = !feedback && offer && AVAILABLE_PHASES.has(offer.phase);
  return (
    <UpdateCheckContext.Provider value={enabled ? {
      checking: manual !== null, disabled: manual !== null || Boolean(active) || installing, available, check: () => void check(),
    } : null}>
      {children}
      {enabled && active && status && <aside className="update-notice" role="status">
        {status.message ?? (status.phase === "downloading" ? `正在下载${status.progress === undefined ? "" : ` ${status.progress}%`}` : status.phase === "installing" ? "正在安装" : "正在重连")}
      </aside>}
      {enabled && (feedback || offer) && <UpdateDialog
        title={feedback ? "检查更新" : offer?.phase === "failed" ? "更新失败" : offer?.phase === "complete" ? "更新已就绪" : `发现 ${product} 新版本`}
        message={feedback ?? (offer?.phase === "available" ? `${offer.currentVersion} → ${offer.targetVersion}` : offer?.message)}
        detail={!feedback && offer?.phase === "available" ? offer.message : undefined}
        hint={!feedback && offer?.phase === "available" ? hint : undefined}
        onDismiss={dismiss}
        dismissLabel={!feedback && offer?.phase === "available" ? "稍后" : "关闭"}
        action={canInstall && <button type="button" className="update-dialog__primary" disabled={installing || refreshing || manual !== null} onClick={() => void install()}>
          <Download size={16} aria-hidden="true" />{offer.phase === "failed" ? "重试更新" : installLabel}
        </button>}
      />}
    </UpdateCheckContext.Provider>
  );
}

function UpdateDialog({ title, message, detail, hint, action, onDismiss, dismissLabel }: {
  title: string; message?: string; detail?: string; hint?: string; action?: ReactNode; onDismiss(): void; dismissLabel: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const nativeModal = typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function";
  useEffect(() => {
    if (!nativeModal) return;
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, [nativeModal]);
  return createPortal(<>
    {!nativeModal && <div className="update-dialog-fallback-backdrop" aria-hidden="true" />}
    <dialog ref={dialog} className="update-dialog" open={!nativeModal} aria-labelledby={titleId} role="dialog" aria-modal="true"
      onCancel={event => { event.preventDefault(); onDismiss(); }}
      onKeyDown={event => { if (!nativeModal && event.key === "Escape") onDismiss(); }}>
      <h2 id={titleId}>{title}</h2>
      {message && <p>{message}</p>}
      {detail && <p>{detail}</p>}
      {hint && <p>{hint}</p>}
      <div className="update-dialog__actions">
        <button type="button" autoFocus onClick={onDismiss}>{dismissLabel}</button>
        {action}
      </div>
    </dialog>
  </>, document.body);
}

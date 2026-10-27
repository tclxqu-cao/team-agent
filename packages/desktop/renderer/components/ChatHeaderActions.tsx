import { useEffect, useState } from "react";
import { Check, FolderOpen, LayoutGrid, LoaderCircle, Monitor, PanelsTopLeft, Unplug, UsersRound } from "lucide-react";
import { nextNavigationLayout } from "../../../core/src/domain/web-console/navigation-layout";
import { useUIStore } from "../stores/uiStore";
import { isDesktopLiveSetupPending } from "../lib/desktop-live-setup";
import type { DesktopLiveStatus } from "../global";
import MobilePairingButton from "./MobilePairingButton";
import HeaderActionMenu from "./HeaderActionMenu";

/**
 * Tracks whether remote authorization still needs user action, so the header
 * monitor action can point back to the authorization dialog after dismissal.
 */
function useDesktopLiveSetupPending(active: boolean): boolean {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!active) return;
    const api = window.agentApi;
    if (!api?.desktopLiveSetup || !api?.onDesktopLiveStatus) return;
    let mounted = true;
    let info: { supported: boolean; needsSetup: boolean } | null = null;
    let status: DesktopLiveStatus | null = null;
    const evaluate = () => {
      if (mounted && info && status) setPending(isDesktopLiveSetupPending({ ...info, status }));
    };
    const refreshInfo = () => void api.desktopLiveSetup().then((next) => {
      if (!mounted) return;
      info = { supported: next.supported, needsSetup: next.needsSetup };
      evaluate();
    }).catch(() => undefined);
    refreshInfo();
    const unsubscribe = api.onDesktopLiveStatus((next) => {
      status = next;
      // Setup may have completed elsewhere (web page / CLI); refresh the stale
      // needsSetup snapshot once the status reports everything authorized.
      if (info?.needsSetup && next.enabled && next.permissionScreen === "granted" && next.accessibilityTrusted === true) refreshInfo();
      evaluate();
    });
    return () => { mounted = false; unsubscribe(); };
  }, [active]);
  return pending;
}

interface ChatHeaderActionsProps {
  appActions?: React.ReactNode;
  appearanceOpen: boolean;
  settingsOpen: boolean;
  showSettings?: boolean;
  hideToBackgroundTitle?: string;
  codexReleaseState?: "idle" | "releasing" | "released";
  onHideToBackground: () => void;
  onReleaseCodex?: () => void;
  onOpenHub?: () => void;
  onOpenCollaborationDashboard?: () => void;
  onOpenDesktopLive?: () => void;
  desktopLiveOpen?: boolean;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
  onToggleAppearance: (anchor: DOMRect) => void;
  onOpenSettings: () => void;
}

export default function ChatHeaderActions({
  appActions,
  appearanceOpen,
  settingsOpen,
  showSettings = true,
  hideToBackgroundTitle = "隐藏到后台",
  codexReleaseState = "idle",
  onHideToBackground,
  onReleaseCodex,
  onOpenHub,
  onOpenCollaborationDashboard,
  onOpenDesktopLive,
  desktopLiveOpen = false,
  filesOpen = false,
  onToggleFiles,
  onToggleAppearance,
  onOpenSettings,
}: ChatHeaderActionsProps) {
  const desktopLivePending = useDesktopLiveSetupPending(Boolean(onOpenDesktopLive));
  const navigationLayout = useUIStore((state) => state.navigationLayout);
  const setNavigationLayout = useUIStore((state) => state.setNavigationLayout);
  const releaseTitle = codexReleaseState === "releasing"
    ? "正在停止 AgentRoam 使用此会话"
    : codexReleaseState === "released"
      ? "已停止在 AgentRoam 中使用；Codex Desktop 最长约 30 分钟后可用"
      : "停止在 AgentRoam 中使用（Codex Desktop 最长约 30 分钟后可用）";
  const actions = (
    <div className="chat-header-actions" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      {appActions}
      {typeof window !== "undefined" && window.sharedServiceApi?.mobilePairing && <MobilePairingButton />}
      {onOpenCollaborationDashboard && <button
        type="button"
        onClick={onOpenCollaborationDashboard}
        title="群聊看板"
        aria-label="打开群聊看板"
        className="ui-icon-button chat-header-action chat-header-action--collaboration"
      >
        <UsersRound size={17} aria-hidden="true" />
      </button>}
      {onOpenDesktopLive && (
        <button
          type="button"
          onClick={onOpenDesktopLive}
          title={desktopLivePending ? "桌面直播与远程控制（待授权）" : "桌面直播与远程控制"}
          aria-label="桌面直播与远程控制"
          aria-expanded={desktopLiveOpen}
          className={`ui-icon-button chat-header-action ${desktopLiveOpen ? "is-active" : ""}`}
          style={{ position: "relative" }}
        >
          <Monitor size={15} aria-hidden="true" />
          {desktopLivePending && <span
            data-desktop-live-pending=""
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 5,
              right: 5,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--warning, #f59e0b)",
              border: "1px solid var(--bg-surface, #fff)",
            }}
          />}
        </button>
      )}
      {onOpenHub && (
        <button
          type="button"
          onClick={onOpenHub}
          title="AI Hub · 多模型网页对比"
          aria-label="打开 AI Hub"
          className="ui-icon-button chat-header-action chat-header-action--ai-hub"
        >
          <LayoutGrid size={15} aria-hidden="true" />
        </button>
      )}
      {onToggleFiles && (
        <button
          type="button"
          onClick={onToggleFiles}
          title="我的文件"
          aria-label="我的文件"
          aria-expanded={filesOpen}
          className={`ui-icon-button chat-header-action chat-header-action--files ${filesOpen ? "is-active" : ""}`}
        >
          <FolderOpen size={15} aria-hidden="true" />
        </button>
      )}
      {onReleaseCodex && (
        <button
          type="button"
          onClick={onReleaseCodex}
          title={releaseTitle}
          aria-label={releaseTitle}
          disabled={codexReleaseState !== "idle"}
          className={`ui-icon-button chat-header-action chat-header-action--codex-release is-${codexReleaseState}`}
        >
          {codexReleaseState === "releasing"
            ? <LoaderCircle size={15} className="spin" aria-hidden="true" />
            : codexReleaseState === "released"
              ? <Check size={15} aria-hidden="true" />
              : <Unplug size={15} aria-hidden="true" />}
        </button>
      )}
      <button
        type="button"
        onClick={onHideToBackground}
        title={hideToBackgroundTitle}
        aria-label="隐藏后台"
        className="ui-icon-button chat-header-action chat-header-action--background"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="14" rx="2" />
          <path d="m9 11 3 3 3-3M12 7v7M8 21h8" />
        </svg>
      </button>
      <button
        type="button"
        onClick={(event) => onToggleAppearance(event.currentTarget.getBoundingClientRect())}
        title="皮肤与布局"
        aria-label="皮肤与布局"
        aria-expanded={appearanceOpen}
        className={`ui-icon-button chat-header-action chat-header-action--appearance ${appearanceOpen ? "is-active" : ""}`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
        </svg>
      </button>
      <button type="button" className="ui-icon-button chat-header-action chat-header-action--navigation-layout"
        aria-label="切换布局" aria-pressed={navigationLayout === "agent-rail"}
        title={navigationLayout === "agent-rail" ? "单层抬头 · 切换到原布局" : "原布局 · 切换到单层抬头"}
        onClick={() => setNavigationLayout(nextNavigationLayout(navigationLayout))}>
        <PanelsTopLeft size={15} aria-hidden="true" />
      </button>
      {showSettings && <button
        type="button"
        onClick={onOpenSettings}
        title="设置"
        aria-label="设置"
        aria-expanded={settingsOpen}
        className={`ui-icon-button chat-header-action chat-header-action--settings ${settingsOpen ? "is-active" : ""}`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>}
    </div>
  );
  return navigationLayout === "agent-rail" ? <HeaderActionMenu>{actions}</HeaderActionMenu> : actions;
}

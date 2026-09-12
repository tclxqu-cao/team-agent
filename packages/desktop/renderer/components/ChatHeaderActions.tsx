import { Check, LayoutGrid, LoaderCircle, Unplug } from "lucide-react";

interface ChatHeaderActionsProps {
  appearanceOpen: boolean;
  settingsOpen: boolean;
  hideToBackgroundTitle?: string;
  codexReleaseState?: "idle" | "releasing" | "released";
  onHideToBackground: () => void;
  onReleaseCodex?: () => void;
  onOpenHub?: () => void;
  onToggleAppearance: (anchor: DOMRect) => void;
  onOpenSettings: () => void;
}

export default function ChatHeaderActions({
  appearanceOpen,
  settingsOpen,
  hideToBackgroundTitle = "隐藏到后台",
  codexReleaseState = "idle",
  onHideToBackground,
  onReleaseCodex,
  onOpenHub,
  onToggleAppearance,
  onOpenSettings,
}: ChatHeaderActionsProps) {
  const releaseTitle = codexReleaseState === "releasing"
    ? "正在停止 AgentRoam 使用此会话"
    : codexReleaseState === "released"
      ? "已停止在 AgentRoam 中使用；Codex Desktop 最长约 30 分钟后可用"
      : "停止在 AgentRoam 中使用（Codex Desktop 最长约 30 分钟后可用）";
  return (
    <div className="chat-header-actions">
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
      <button
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
      </button>
    </div>
  );
}

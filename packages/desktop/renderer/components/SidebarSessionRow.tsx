import { CircleAlert, ChevronRight, LoaderCircle, LockKeyhole, Pin, Trash2 } from "lucide-react";
import type { SidebarSessionVisualState } from "../lib/sidebar-session-status";
import type { SessionCompatibility } from "../global";

export interface SidebarSessionRowModel {
  id: string;
  title: string;
  visualState: SidebarSessionVisualState;
  statusLabel: string;
  occupiedExternally: boolean;
  canDelete: boolean;
  active: boolean;
  child?: boolean;
  hasChildren?: boolean;
  expanded?: boolean;
  compatibility?: SessionCompatibility;
  pinned?: boolean;
}

export interface SidebarDeleteAnchor {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface SidebarSessionRowProps {
  session: SidebarSessionRowModel;
  deleteLabel?: string;
  onSelect(): void;
  onPin?(): void;
  onDelete?(anchor: SidebarDeleteAnchor): void;
}

export default function SidebarSessionRow({
  session,
  deleteLabel = "删除会话",
  onSelect,
  onPin,
  onDelete,
}: SidebarSessionRowProps) {
  return (
    <div
      className={`sidebar-row sidebar-session-row${session.child ? " sidebar-session-row--child" : ""}${session.active ? " sidebar-row-active" : ""}`}
    >
      <button
        type="button"
        className="sidebar-session-button"
        onClick={onSelect}
        aria-pressed={session.active}
        aria-expanded={session.hasChildren ? Boolean(session.expanded) : undefined}
        title={session.title}
      >
        <span
          className={`sidebar-status-dot is-${session.visualState}`}
          title={session.statusLabel}
          aria-label={session.statusLabel}
        />
        <span className="sidebar-session-title">{session.title}</span>
        {session.compatibility?.status === "checking" && (
          <span
            className="sidebar-session-compatibility"
            title={`正在验证 Codex ${session.compatibility.producerVersion ?? "未知版本"} 会话兼容性`}
            aria-label="正在验证会话兼容性"
          >
            <LoaderCircle size={13} style={{ animation: "spin 1s linear infinite" }} aria-hidden="true" />
          </span>
        )}
        {session.compatibility?.status === "incompatible" && (
          <span
            className="sidebar-session-compatibility"
            title={session.compatibility.reason ?? "Codex 版本不兼容"}
            aria-label="Codex 版本不兼容"
          >
            <CircleAlert size={13} aria-hidden="true" />
          </span>
        )}
        {session.occupiedExternally && (
          <span
            className="sidebar-session-lock"
            title="原客户端正在使用，只读"
            aria-label="原客户端正在使用，只读"
          >
            <LockKeyhole size={13} aria-hidden="true" />
          </span>
        )}
        {session.hasChildren && (
          <ChevronRight
            size={13}
            className={`sidebar-session-disclosure${session.expanded ? " is-expanded" : ""}`}
            aria-hidden="true"
          />
        )}
      </button>
      {onPin && !session.child && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onPin();
          }}
          title={session.pinned ? "取消置顶" : "置顶会话"}
          aria-label={`${session.pinned ? "取消置顶" : "置顶会话"}：${session.title}`}
          aria-pressed={Boolean(session.pinned)}
          className={`sidebar-session-pin sidebar-row-action ui-icon-button ui-icon-button--small${session.pinned ? " sidebar-row-action--accent" : ""}`}
        >
          <Pin size={14} aria-hidden="true" />
        </button>
      )}
      {session.canDelete && onDelete && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onDelete({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
          }}
          title={deleteLabel}
          aria-label={`${deleteLabel}：${session.title}`}
          className="sidebar-session-delete sidebar-row-action ui-icon-button ui-icon-button--small ui-icon-button--danger"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

import { CircleAlert, CircleHelp, LockKeyhole, Pin, Trash2 } from "lucide-react";
import type { SidebarSessionVisualState } from "../lib/sidebar-session-status";
import type { AgentType, SessionCompatibility } from "../../../shared/src/contracts/agent-api";
import AgentBrandIcon from "./AgentBrandIcon";
import SessionDisclosureButton from "./SessionDisclosureButton";
import SessionStatusDot from "./SessionStatusDot";
import { AGENT_LABELS } from "../lib/agent-catalog";

export interface SidebarSessionRowModel {
  id: string;
  title: string;
  visualState: SidebarSessionVisualState;
  statusLabel: string;
  occupiedExternally: boolean;
  canDelete: boolean;
  active: boolean;
  child?: boolean;
  expanded?: boolean;
  compatibility?: SessionCompatibility;
  pinned?: boolean;
  agentType?: AgentType;
  workspacePath?: string;
  completedAt?: string;
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
  onToggleChildren?(): void;
  onPin?(): void;
  onDelete?(anchor: SidebarDeleteAnchor): void;
}

export default function SidebarSessionRow({
  session,
  deleteLabel = "删除会话",
  onSelect,
  onToggleChildren,
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
        title={[session.title, session.workspacePath].filter(Boolean).join("\n")}
      >
        <SessionStatusDot session={session} visualState={session.visualState} statusLabel={session.statusLabel} active={session.active} />
        <span className="sidebar-session-title">{session.title}</span>
        {session.agentType && <span className="sidebar-session-agent" role="img" aria-label={AGENT_LABELS[session.agentType]} title={AGENT_LABELS[session.agentType]}>
          <AgentBrandIcon agentType={session.agentType} size={18} />
        </span>}
        {session.compatibility?.status === "checking" && (
          <span
            className="sidebar-session-compatibility"
            title={`Codex ${session.compatibility.producerVersion ?? "未知版本"} 会话兼容性待验证，打开会话时检查`}
            aria-label="会话兼容性待验证，打开会话时检查"
          >
            <CircleHelp size={13} aria-hidden="true" />
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
      </button>
      {onToggleChildren && (
        <SessionDisclosureButton title={session.title} expanded={Boolean(session.expanded)} onToggle={onToggleChildren} />
      )}
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

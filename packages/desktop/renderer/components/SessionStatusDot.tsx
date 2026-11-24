import { SIDEBAR_SESSION_STATUS_LABELS, sessionCompletedAt, type SidebarSessionVisualState } from "../lib/sidebar-session-status";
import { isUnreadCompletion, useSessionCompletionStore } from "../stores/session-completion-store";

interface Props {
  session: { id: string; status?: string; updated?: string; completedAt?: string };
  visualState?: SidebarSessionVisualState;
  statusLabel?: string;
  className?: string;
  active?: boolean;
}

export default function SessionStatusDot({ session, visualState, statusLabel, className, active }: Props) {
  const state = visualState ?? (session.status === "failed" ? "error"
    : session.status === "unknown" ? "stale"
    : session.status === "running" || session.status === "needs-input" ? session.status : "completed");
  const completedAt = sessionCompletedAt(session);
  const unread = useSessionCompletionStore(store => state === "completed" && !active
    && isUnreadCompletion(store.receipts[session.id], completedAt, store.sharedViews.get(session.id)));
  const label = unread ? "已完成，未查看"
    : statusLabel ?? (session.status === "idle" && !completedAt ? "空闲" : SIDEBAR_SESSION_STATUS_LABELS[state]);
  return <span className={`sidebar-status-dot is-${state}${unread ? " is-unread-completion" : ""}${className ? ` ${className}` : ""}`}
    role="img" title={label} aria-label={label} />;
}

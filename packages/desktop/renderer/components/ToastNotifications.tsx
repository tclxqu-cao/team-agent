import { BellRing, CalendarCheck2, CircleCheck, CircleX, ClockAlert, MessageCircleQuestion, X } from "lucide-react";
import type { PersistentNotification } from "@agent/core";
import { notificationPresentation } from "../../shared/notification-presentation";
import "../styles/notification-toasts.css";

export interface ToastNotificationsProps {
  items: PersistentNotification[];
  onOpen: (notification: PersistentNotification) => void;
  onDismiss: (notification: PersistentNotification) => void;
  onClearAll?: () => void;
}

/** Keep notification previews focused on the result; full content remains in the session. */
export function notificationPreview(value: string, limit = 180): string {
  const plain = value
    .replace(/```[^\n]*\n?[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[^\n]*\n?[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\((?:[^)(]|\([^)]*\))*\)/g, "$1")
    .replace(/`(?:\/|~\/|[A-Za-z]:\\)[^`]*`/g, " ")
    .replace(/(?:file:\/\/\/|\/(?:Users|home|tmp|private|var|Applications|Volumes)\/|~\/|[A-Za-z]:\\)[^\s<>`"'，。；、）)]+/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)([\s\S]*?)\1/g, "$2")
    .replace(/(^|\s)[*_]([^\s*_][^*_]*?)[*_](?=\s|[，。！？,.!?]|$)/g, "$1$2")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([，。；、）])/g, "$1")
    .trim();
  const characters = Array.from(plain);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : plain;
}

const NOTIFICATION_ICONS = {
  completion: CircleCheck,
  approval: MessageCircleQuestion,
  todo_reminder: BellRing,
  todo_execution: CalendarCheck2,
  todo_attention: ClockAlert,
  todo_error: CircleX,
} as const;

const GENERIC_COMPLETION_TITLES = new Set([
  "会话已完成", "会话完成", "任务完成", "任务已完成", "运行已结束", "运行结束", "已完成",
]);

export default function ToastNotifications({ items, onOpen, onDismiss, onClearAll }: ToastNotificationsProps) {
  if (items.length === 0) return null;
  return (
    <aside className="notification-toasts" aria-label="通知">
      {items.length > 1 && onClearAll && (
        <button
          type="button"
          className="notification-toasts__clear"
          title="全部标为已读并清除"
          onClick={(event) => {
            event.stopPropagation();
            onClearAll();
          }}
        >
          全部清除
        </button>
      )}
      {items.slice(0, 3).map((notification) => {
        const { type, label } = notificationPresentation(notification);
        const Icon = NOTIFICATION_ICONS[type];
        const title = notificationPreview(notification.title, 100) || label;
        const showTitle = notification.kind !== "completion"
          || !GENERIC_COMPLETION_TITLES.has(title.replace(/[\s。.!！:：]+/g, ""));
        const preview = notificationPreview(notification.body) || "点击查看详细内容";
        return (
          <article className={`notification-toast notification-toast--${type}`} key={notification.id} data-notification-id={notification.id} data-notification-type={type}>
            <button
              type="button"
              className="notification-toast__content"
              aria-label={`${showTitle ? title : label}，打开查看`}
              onClick={() => onOpen(notification)}
            >
              <span className="notification-toast__icon" aria-hidden="true"><Icon size={15} strokeWidth={1.8} /></span>
              <span className="notification-toast__body" role="status">
                <span className="notification-toast__meta">
                  <span>{label}</span>
                  <span className="notification-toast__dot" aria-hidden="true" />
                  <span className="notification-toast__unread">未读</span>
                </span>
                {showTitle && <strong className="notification-toast__title">{title}</strong>}
                <span className="notification-toast__summary">{preview}</span>
              </span>
            </button>
            <button
              type="button"
              className="notification-toast__close"
              aria-label="关闭通知并标为已读"
              title="关闭并标为已读"
              onClick={(event) => {
                event.stopPropagation();
                onDismiss(notification);
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </article>
        );
      })}
    </aside>
  );
}

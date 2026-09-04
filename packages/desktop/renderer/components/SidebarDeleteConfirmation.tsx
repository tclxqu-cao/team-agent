import type { CSSProperties, MouseEvent } from "react";
import type { SidebarDeleteAnchor } from "./SidebarSessionRow";

interface SidebarDeleteConfirmationProps {
  message: string;
  anchor: SidebarDeleteAnchor;
  mobile: boolean;
  pending: boolean;
  onCancel(): void;
  onConfirm(): void;
}

const POPOVER_WIDTH = 264;
const POPOVER_HEIGHT = 126;

function getPopoverPosition(anchor: SidebarDeleteAnchor): CSSProperties {
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const left = Math.max(8, Math.min(anchor.left + anchor.width - POPOVER_WIDTH, viewportWidth - POPOVER_WIDTH - 8));
  const below = anchor.top + anchor.height + 7;
  const top = below + POPOVER_HEIGHT <= viewportHeight - 8
    ? below
    : Math.max(8, anchor.top - POPOVER_HEIGHT - 7);
  return { left, top, width: POPOVER_WIDTH };
}

export default function SidebarDeleteConfirmation({
  message,
  anchor,
  mobile,
  pending,
  onCancel,
  onConfirm,
}: SidebarDeleteConfirmationProps) {
  const stopPropagation = (event: MouseEvent<HTMLDivElement>) => event.stopPropagation();
  return (
    <div
      className={`sidebar-delete-confirmation-layer${mobile ? " is-mobile" : ""}`}
      onClick={pending ? undefined : onCancel}
    >
      <div
        className="sidebar-delete-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sidebar-delete-confirmation-title"
        aria-describedby="sidebar-delete-confirmation-message"
        style={mobile ? undefined : getPopoverPosition(anchor)}
        onClick={stopPropagation}
      >
        <strong id="sidebar-delete-confirmation-title">删除会话</strong>
        <p id="sidebar-delete-confirmation-message">{message}</p>
        <div className="sidebar-delete-confirmation-actions">
          <button type="button" onClick={onCancel} disabled={pending}>取消</button>
          <button type="button" className="is-danger" onClick={onConfirm} disabled={pending}>
            {pending ? "正在删除..." : "删除"}
          </button>
        </div>
      </div>
    </div>
  );
}

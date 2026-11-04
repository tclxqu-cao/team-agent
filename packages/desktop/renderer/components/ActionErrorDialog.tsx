import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import "../styles/action-error-dialog.css";

/** Uses the sidebar deletion card's typography, spacing and action layout. */
export default function ActionErrorDialog({ title, message, onClose, onRetry }: {
  title: string;
  message: string;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="sidebar-delete-confirmation action-error-dialog"
    role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <strong id={`${id}-title`}>{title}</strong>
    <p id={`${id}-message`}>{message}</p>
    <div className="sidebar-delete-confirmation-actions">
      <button type="button" autoFocus onClick={onClose}>{onRetry ? "关闭" : "知道了"}</button>
      {onRetry && <button type="button" className="is-primary" onClick={() => { onClose(); onRetry(); }}>重试</button>}
    </div>
  </dialog>, document.body);
}

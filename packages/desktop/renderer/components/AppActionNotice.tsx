import { createPortal } from "react-dom";

export type AppActionNoticeType = "success" | "info" | "error";

export default function AppActionNotice({
  message,
  type,
}: {
  message: string | null;
  type: AppActionNoticeType;
}) {
  if (!message) return null;
  return createPortal(
    <div
      className={`app-action-notice is-${type}`}
      role={type === "error" ? "alert" : "status"}
      aria-live={type === "error" ? "assertive" : "polite"}
    >
      <span className="app-action-notice-mark" aria-hidden="true">
        {type === "success" ? "✓" : type === "info" ? "i" : "!"}
      </span>
      <span>{message}</span>
    </div>,
    document.body,
  );
}

import "../styles/session-loading.css";

export default function SessionLoading({ className = "", label = "正在加载会话" }: {
  className?: string;
  label?: string;
}) {
  return <div className={`session-loading ${className}`} role="status" aria-live="polite" aria-label={label}>
    <div className="session-loading-content">
      <span className="session-loading-orbit" aria-hidden="true">
        <span className="session-loading-track" />
        <span className="session-loading-dots"><i /><i /><i /></span>
        <span className="session-loading-core" />
      </span>
      <span className="session-loading-label" aria-hidden="true">{label}</span>
    </div>
  </div>;
}

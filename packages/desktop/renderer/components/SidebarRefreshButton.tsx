import { CircleAlert, RefreshCw } from "lucide-react";

export default function SidebarRefreshButton({ loading, error, onRefresh, subject = "目录" }: {
  loading: boolean;
  error: string | null;
  onRefresh(): void;
  subject?: string;
}) {
  const label = loading ? `正在加载${subject}` : error ? `${subject}加载失败，点击重试` : `刷新${subject}`;
  return <button
    type="button"
    disabled={loading}
    onClick={onRefresh}
    title={error && !loading ? `${label}：${error}` : label}
    aria-label={label}
    aria-busy={loading}
    className="ui-icon-button sidebar-directory-refresh"
  >
    <RefreshCw size={17} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
    {error && !loading && <CircleAlert size={10} className="sidebar-directory-refresh-error" aria-hidden="true" />}
  </button>;
}

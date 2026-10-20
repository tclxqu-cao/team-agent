import { CircleAlert, RefreshCw } from "lucide-react";

export default function SidebarRefreshButton({ loading, error, onRefresh }: {
  loading: boolean;
  error: string | null;
  onRefresh(): void;
}) {
  const label = loading ? "正在加载目录" : error ? "目录加载失败，点击重试" : "刷新目录";
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

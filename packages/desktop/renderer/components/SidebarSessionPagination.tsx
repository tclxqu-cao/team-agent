import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";

export default function SidebarSessionPagination({
  cursor, expanded, loading, error, nestedScroll, projectName, onLoadMore,
}: {
  cursor: string | null;
  expanded: boolean;
  loading: boolean;
  error?: string;
  nestedScroll: boolean;
  projectName: string;
  onLoadMore(): void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const lastAutomaticCursor = useRef<string | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || !cursor || !expanded || loading || error || typeof IntersectionObserver === "undefined") return;
    const root = button.closest(nestedScroll ? ".sidebar-project-sessions" : ".app-sidebar-scroll");
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || lastAutomaticCursor.current === cursor) return;
      lastAutomaticCursor.current = cursor;
      loadMoreRef.current();
    }, { root, rootMargin: "0px 0px 80px 0px" });
    observer.observe(button);
    return () => observer.disconnect();
  }, [cursor, expanded, loading, error, nestedScroll]);

  if (!cursor) return null;
  const label = loading ? "正在加载历史会话..." : error ? "重试加载历史会话" : "加载更早的会话";
  return <button
    ref={buttonRef}
    type="button"
    className="sidebar-session-load-more"
    aria-label={`${projectName}：${label}`}
    aria-busy={loading}
    disabled={loading}
    title={error}
    onClick={() => {
      lastAutomaticCursor.current = cursor;
      onLoadMore();
    }}
    style={{
      display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
      flexShrink: 0, minHeight: 36, padding: "6px 10px", border: 0,
      background: "transparent", color: error ? "var(--danger)" : "var(--text-muted)",
      fontSize: 11, cursor: loading ? "default" : "pointer",
    }}
  >
    {loading && <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />}
    {label}
  </button>;
}

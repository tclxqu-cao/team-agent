import { ChevronRight } from "lucide-react";

export default function SessionDisclosureButton({ title, expanded, onToggle }: {
  title: string;
  expanded: boolean;
  onToggle(): void;
}) {
  const label = `${expanded ? "收起" : "展开"}子会话：${title}`;
  return <button
    type="button"
    className="sidebar-session-toggle ui-icon-button ui-icon-button--small"
    aria-label={label}
    title={label}
    aria-expanded={expanded}
    onClick={onToggle}
  >
    <ChevronRight size={15} className={`sidebar-session-disclosure${expanded ? " is-expanded" : ""}`} aria-hidden="true" />
  </button>;
}

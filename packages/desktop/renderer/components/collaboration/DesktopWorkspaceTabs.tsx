import { X } from "lucide-react";
import type { CollaborationGroup } from "@agent/core/domain/collaboration/types";

interface DesktopWorkspaceTabsProps {
  groups: CollaborationGroup[];
  dashboardVisible: boolean;
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export default function DesktopWorkspaceTabs({ groups, dashboardVisible, activeId, onSelect, onClose }: DesktopWorkspaceTabsProps) {
  const tabs = [
    { id: "assistant", name: "智能助手", closable: false },
    ...(dashboardVisible ? [{ id: "dashboard", name: "群聊看板", closable: true }] : []),
    ...groups.map(group => ({ id: group.id, name: group.name, closable: true })),
  ];
  return <nav className="collab-desktop-tabs" aria-label="工作页签">
    {tabs.map(tab => <div key={tab.id} className={`collab-desktop-tab${activeId === tab.id ? " is-active" : ""}`}>
      <button type="button" aria-current={activeId === tab.id ? "page" : undefined} onClick={() => onSelect(tab.id)}>{tab.name}</button>
      {tab.closable && <button type="button" className="collab-desktop-tab-close" aria-label={`关闭${tab.name}`} title={`关闭${tab.name}页签`} onClick={() => onClose(tab.id)}><X size={13} aria-hidden="true" /></button>}
    </div>)}
    <div className="collab-desktop-tabs-drag-space" aria-hidden="true" />
  </nav>;
}

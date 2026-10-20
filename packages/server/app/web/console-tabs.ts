export interface ConsoleTab {
  id: string;
  title: string;
  kind?: "webapp" | "aihub" | "flowstudio" | "remote-desktop" | "collaboration" | "collaboration-dashboard";
  groupId?: string;
  initialCommand?: string;
}

export interface WorkspaceSnapshot {
  tabs: ConsoleTab[];
  activeTerminalId: string | null;
}

export function parseWorkspaceSnapshot(raw: string | null): WorkspaceSnapshot | null {
  try {
    const value = JSON.parse(raw || "null");
    if (!value || !Array.isArray(value.tabs)) return null;
    const ids = new Set<string>();
    const kinds = new Set(["webapp", "aihub", "flowstudio", "remote-desktop", "collaboration", "collaboration-dashboard"]);
    const tabs: ConsoleTab[] = [];
    for (const tab of value.tabs.slice(0, 100)) {
      if (!tab || typeof tab.id !== "string" || typeof tab.title !== "string" || ids.has(tab.id)) continue;
      if (tab.kind !== undefined && !kinds.has(tab.kind)) continue;
      if (tab.kind === "collaboration" && typeof tab.groupId !== "string") continue;
      ids.add(tab.id);
      tabs.push({ id: tab.id, title: tab.title, ...(tab.kind ? { kind: tab.kind } : {}), ...(typeof tab.groupId === "string" ? { groupId: tab.groupId } : {}) });
    }
    return { tabs, activeTerminalId: typeof value.activeTerminalId === "string" ? value.activeTerminalId : null };
  } catch { return null; }
}

export function restoreWorkspaceTabs(saved: WorkspaceSnapshot | null, terminals: Array<{ id: string; title: string; status: string }>, current: ConsoleTab[]): ConsoleTab[] {
  const available = new Map<string, ConsoleTab>(terminals.filter(tab => tab.status === "active" || tab.status === "detached").map(tab => [tab.id, { id: tab.id, title: tab.title }]));
  const result: ConsoleTab[] = [];
  const ids = new Set<string>();
  for (const tab of [...(saved?.tabs ?? []), ...current, ...available.values()]) {
    if (ids.has(tab.id) || (!tab.kind && !available.has(tab.id))) continue;
    ids.add(tab.id);
    result.push(tab.kind ? tab : available.get(tab.id)!);
  }
  return result;
}

export const REMOTE_DESKTOP_TAB = { id: "remote-desktop", title: "远程桌面", kind: "remote-desktop" } as const;

export function withRemoteDesktopTab(tabs: ConsoleTab[]): ConsoleTab[] {
  const existing = tabs.find((tab) => tab.kind === "remote-desktop");
  return existing
    ? tabs.map((tab) => tab === existing ? { ...REMOTE_DESKTOP_TAB } : tab)
    : [...tabs, { ...REMOTE_DESKTOP_TAB }];
}

export const COLLABORATION_DASHBOARD_TAB = { id: "collaboration-dashboard", title: "群聊看板", kind: "collaboration-dashboard" } as const;
export function withCollaborationDashboard(tabs: ConsoleTab[]): ConsoleTab[] {
  return tabs.some(tab => tab.id === COLLABORATION_DASHBOARD_TAB.id)
    ? tabs : [...tabs, { ...COLLABORATION_DASHBOARD_TAB }];
}

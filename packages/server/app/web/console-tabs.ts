export interface ConsoleTab {
  id: string;
  title: string;
  kind?: "webapp" | "aihub" | "flowstudio" | "remote-desktop";
  initialCommand?: string;
}

export const REMOTE_DESKTOP_TAB = { id: "remote-desktop", title: "远程桌面", kind: "remote-desktop" } as const;

export function withRemoteDesktopTab(tabs: ConsoleTab[]): ConsoleTab[] {
  const existing = tabs.find((tab) => tab.kind === "remote-desktop");
  return existing
    ? tabs.map((tab) => tab === existing ? { ...REMOTE_DESKTOP_TAB } : tab)
    : [...tabs, { ...REMOTE_DESKTOP_TAB }];
}

import { describe, expect, it } from "vitest";
import { COLLABORATION_DASHBOARD_TAB, withCollaborationDashboard, REMOTE_DESKTOP_TAB, withRemoteDesktopTab } from "./console-tabs";

describe("remote desktop utility tab", () => {
  it("opens a single group dashboard without replacing existing chat tabs", () => {
    const group = { id: "collaboration-g", groupId: "g", kind: "collaboration" as const, title: "群" };
    const tabs = withCollaborationDashboard([group]);
    expect(tabs).toEqual([group, COLLABORATION_DASHBOARD_TAB]);
    expect(withCollaborationDashboard(tabs)).toBe(tabs);
  });

  it("adds a separate tab and preserves the chat and terminal objects", () => {
    const chat = { id: "webapp-agent", title: "智能助手", kind: "webapp" as const };
    const terminal = { id: "t-1", title: "Terminal" };
    const tabs = withRemoteDesktopTab([chat, terminal]);
    expect(tabs).toEqual([chat, terminal, REMOTE_DESKTOP_TAB]);
    expect(tabs[0]).toBe(chat);
    expect(tabs[1]).toBe(terminal);
  });

  it("reuses the remote tab with a fixed title", () => {
    const tabs = withRemoteDesktopTab([{ ...REMOTE_DESKTOP_TAB, title: "任意标题" }]);
    expect(withRemoteDesktopTab(tabs)).toEqual([REMOTE_DESKTOP_TAB]);
  });
});

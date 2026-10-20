import { describe, expect, it } from "vitest";
import { COLLABORATION_DASHBOARD_TAB, withCollaborationDashboard, REMOTE_DESKTOP_TAB, withRemoteDesktopTab } from "./console-tabs";
import { parseWorkspaceSnapshot, restoreWorkspaceTabs } from "./console-tabs";

describe("workspace refresh recovery", () => {
  const chat = { id: "webapp-agent", title: "Assistant", kind: "webapp" as const };
  it("restores tab order and selection without rerunning a command", () => {
    const saved = parseWorkspaceSnapshot(JSON.stringify({ tabs: [chat, REMOTE_DESKTOP_TAB, { id: "t-1", title: "shell", initialCommand: "dangerous-command" }], activeTerminalId: "remote-desktop" }));
    expect(saved?.activeTerminalId).toBe("remote-desktop");
    expect(saved?.tabs[2]).not.toHaveProperty("initialCommand");
    expect(restoreWorkspaceTabs(saved, [{ id: "t-1", title: "renamed", status: "detached" }], [chat]).map(tab => tab.id)).toEqual(["webapp-agent", "remote-desktop", "t-1"]);
  });
  it("drops closed terminals, preserves utilities and discovers live terminals", () => {
    const saved = { tabs: [chat, { id: "old", title: "old" }, REMOTE_DESKTOP_TAB], activeTerminalId: "old" };
    expect(restoreWorkspaceTabs(saved, [{ id: "old", title: "old", status: "closed" }, { id: "new", title: "new", status: "active" }], [chat]).map(tab => tab.id)).toEqual(["webapp-agent", "remote-desktop", "new"]);
  });
  it("ignores malformed storage and unsupported or duplicate tabs", () => {
    expect(parseWorkspaceSnapshot("{" )).toBeNull();
    expect(parseWorkspaceSnapshot(JSON.stringify({ tabs: [chat, chat, { id: "bad", title: "bad", kind: "unknown" }] }))?.tabs).toEqual([chat]);
  });
});

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

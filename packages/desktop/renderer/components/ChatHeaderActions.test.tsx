import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ navigationLayout: "classic", webShell: false }));
vi.mock("../stores/uiStore", () => ({ useUIStore: (selector: (value: typeof state) => unknown) => selector(state) }));
vi.mock("../web/webLayout", () => ({ isWebShell: () => state.webShell }));
import ChatHeaderActions from "./ChatHeaderActions";
import DesktopAppActions from "./DesktopAppActions";
import UpdateNotice, { type UpdateNoticeApi } from "./UpdateNotice";

const noop = () => {};
const getUpdateStatus: UpdateNoticeApi["getUpdateStatus"] = async () => ({ phase: "idle", currentVersion: "1.0.0" });
const updateApi: UpdateNoticeApi = {
  getUpdateStatus,
  checkForUpdate: getUpdateStatus,
  installUpdate: getUpdateStatus,
  onUpdateStatus: () => noop,
};
const render = (showSettings: boolean) => renderToStaticMarkup(createElement(UpdateNotice, { api: updateApi }, createElement(ChatHeaderActions, {
  appearanceOpen: false, settingsOpen: false, showSettings,
  onHideToBackground: noop, onToggleAppearance: noop, onOpenSettings: noop,
  onToggleFiles: noop, onOpenHub: noop, onOpenDesktopLive: noop,
  onOpenCollaborationDashboard: noop, onOpenSessionDashboard: noop, onReleaseCodex: noop,
})));

describe("chat header action layout", () => {
  beforeEach(() => { state.navigationLayout = "classic"; state.webShell = false; });

  it("keeps the classic desktop toolbar with the download action and without Codex release", () => {
    state.navigationLayout = "classic";
    const html = render(true);
    expect(html).toContain('class="chat-header-actions"');
    expect(html).not.toContain("header-action-menu-trigger");
    expect(html).toContain('aria-label="设置"');
    expect(html).toMatch(/aria-label="检查更新"[^>]*><svg[^>]*class="[^"]*lucide-download/);
    expect(html).toContain('aria-label="隐藏后台"');
    expect(html).not.toContain("chat-header-action--codex-release");
  });

  it.each(["agent-rail", "all-sessions"])("omits Codex release and hide to background from the %s disclosure", navigationLayout => {
    state.navigationLayout = navigationLayout;
    const html = render(true);
    expect(html).toContain("header-action-menu-trigger");
    expect(html).toContain('aria-label="检查更新"');
    expect(html.indexOf('aria-label="检查更新"')).toBeLessThan(html.indexOf("header-action-menu-trigger"));
    for (const label of ["我的文件", "打开 AI Hub", "桌面直播与远程控制", "打开群聊列表", "打开进行中的 Agent 会话", "皮肤与布局", "设置"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).not.toContain("chat-header-action--codex-release");
    expect(html).not.toContain('aria-label="隐藏后台"');
    expect(html).toContain("lucide-folder-open");
    expect(html).not.toContain("消息接入");
    expect(html).not.toContain("lucide-inbox");
    expect(html).not.toContain('aria-label="切换布局"');
    expect(html).not.toContain("lucide-panel-left");
    expect(html).not.toContain("lucide-panel-right");
  });

  it.each(["classic", "agent-rail", "all-sessions"])("shows web conversation actions directly with %s navigation", navigationLayout => {
    state.navigationLayout = navigationLayout;
    state.webShell = true;
    const html = render(true);
    expect(html).not.toContain("header-action-menu-trigger");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-label="检查更新"');
    for (const label of ["我的文件", "打开 AI Hub", "停止在 AgentRoam 中使用（Codex Desktop 最长约 30 分钟后可用）", "设置"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it("offers update checks when the Agent settings are hidden", () => {
    state.navigationLayout = "agent-rail";
    const html = render(false);
    expect(html).not.toContain('aria-label="设置"');
    expect(html).toContain('aria-label="检查更新"');
  });

  it("exposes task split when the host enables it, including the desktop browser", () => {
    const props = { appearanceOpen: false, settingsOpen: false,
      onHideToBackground: noop, onToggleAppearance: noop, onOpenSettings: noop,
      onOpenSessionDashboard: noop, onOpenTaskSplit: noop };
    const desktop = renderToStaticMarkup(createElement(ChatHeaderActions, props));
    expect(desktop).toMatch(/aria-label="打开任务分屏"[^>]*><svg[^>]*class="[^"]*lucide-columns2/);
    expect(desktop).toContain('aria-label="打开进行中的 Agent 会话"');
    state.webShell = true;
    expect(renderToStaticMarkup(createElement(ChatHeaderActions, props))).toContain('aria-label="打开任务分屏"');
    expect(renderToStaticMarkup(createElement(ChatHeaderActions, { ...props, onOpenTaskSplit: undefined }))).not.toContain('aria-label="打开任务分屏"');
  });

  it("includes the desktop calendar in the shared action menu", () => {
    state.navigationLayout = "agent-rail";
    const html = renderToStaticMarkup(createElement(ChatHeaderActions, {
      appearanceOpen: false, settingsOpen: false,
      onHideToBackground: noop, onToggleAppearance: noop, onOpenSettings: noop,
      appActions: createElement(DesktopAppActions, { onOpenCalendar: noop }),
    }));
    expect(html.match(/header-action-menu-trigger/g)).toHaveLength(1);
    expect(html).toContain('aria-label="打开日历"');
  });
});

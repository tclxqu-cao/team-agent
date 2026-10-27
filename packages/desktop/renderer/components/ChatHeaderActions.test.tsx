import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ navigationLayout: "classic", setNavigationLayout: vi.fn() }));
vi.mock("../stores/uiStore", () => ({ useUIStore: (selector: (value: typeof state) => unknown) => selector(state) }));
import ChatHeaderActions from "./ChatHeaderActions";
import DesktopAppActions from "./DesktopAppActions";

const noop = () => {};
const render = (showSettings: boolean) => renderToStaticMarkup(createElement(ChatHeaderActions, {
  appearanceOpen: false, settingsOpen: false, showSettings,
  onHideToBackground: noop, onToggleAppearance: noop, onOpenSettings: noop,
  onToggleFiles: noop, onOpenHub: noop, onOpenDesktopLive: noop,
  onOpenCollaborationDashboard: noop, onReleaseCodex: noop,
}));

describe("chat header action layout", () => {
  it("keeps the classic inline toolbar", () => {
    state.navigationLayout = "classic";
    const html = render(true);
    expect(html).toContain('class="chat-header-actions"');
    expect(html).not.toContain("header-action-menu-trigger");
    expect(html).toContain('aria-label="设置"');
  });

  it("collects all previous icon actions in the rail disclosure", () => {
    state.navigationLayout = "agent-rail";
    const html = render(true);
    expect(html).toContain("header-action-menu-trigger");
    for (const label of ["我的文件", "打开 AI Hub", "桌面直播与远程控制", "打开群聊看板", "隐藏后台", "皮肤与布局", "切换布局", "设置"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain("chat-header-action--codex-release");
    expect(html).toContain("lucide-folder-open");
    expect(html).toContain("lucide-panels-top-left");
    expect(html).not.toContain("lucide-panel-left");
    expect(html).not.toContain("lucide-panel-right");
    expect(html.indexOf("chat-header-action--appearance")).toBeLessThan(html.indexOf("chat-header-action--navigation-layout"));
  });

  it("does not expose CA settings for native Agents inside the menu", () => {
    state.navigationLayout = "agent-rail";
    expect(render(false)).not.toContain('aria-label="设置"');
  });

  it("keeps desktop quick actions in the same menu with their busy state", () => {
    state.navigationLayout = "agent-rail";
    const html = renderToStaticMarkup(createElement(ChatHeaderActions, {
      appearanceOpen: false, settingsOpen: false,
      onHideToBackground: noop, onToggleAppearance: noop, onOpenSettings: noop,
      appActions: createElement(DesktopAppActions, { onOpenFlowStudio: noop, openingFlowStudio: true }),
    }));
    expect(html.match(/header-action-menu-trigger/g)).toHaveLength(1);
    expect(html).toContain('aria-label="打开 Flow Studio"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
  });
});

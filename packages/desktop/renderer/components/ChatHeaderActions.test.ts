import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChatHeaderActions from "./ChatHeaderActions";

const baseProps = {
  appearanceOpen: false,
  settingsOpen: false,
  onHideToBackground: () => {},
  onToggleAppearance: () => {},
  onOpenSettings: () => {},
};

describe("ChatHeaderActions", () => {
  it("renders global actions in the required order", () => {
    const html = renderToStaticMarkup(createElement(ChatHeaderActions, baseProps));

    expect(html.indexOf('aria-label="隐藏后台"')).toBeLessThan(
      html.indexOf('aria-label="皮肤与布局"'),
    );
    expect(html.indexOf('aria-label="皮肤与布局"')).toBeLessThan(
      html.indexOf('aria-label="设置"'),
    );
  });

  it("renders the browser live action only when the Web bridge is available", () => {
    const hidden = renderToStaticMarkup(createElement(ChatHeaderActions, baseProps));
    const visible = renderToStaticMarkup(createElement(ChatHeaderActions, {
      ...baseProps,
      onOpenBrowserLive: () => {},
    }));

    expect(hidden).not.toContain('aria-label="打开浏览器直播"');
    expect(visible).toContain('aria-label="打开浏览器直播"');
    expect(visible).not.toContain(">浏览器直播<");
  });

  it("renders the AI Hub action only when the desktop hub bridge is available", () => {
    const hidden = renderToStaticMarkup(createElement(ChatHeaderActions, baseProps));
    const visible = renderToStaticMarkup(createElement(ChatHeaderActions, {
      ...baseProps,
      onOpenHub: () => {},
      onOpenBrowserLive: () => {},
    }));

    expect(hidden).not.toContain('aria-label="打开 AI Hub"');
    expect(visible).toContain('aria-label="打开 AI Hub"');
    expect(visible).toContain("chat-header-action--ai-hub");
    expect(visible).not.toContain(">AI Hub · 多模型网页对比<");
    expect(visible.indexOf('aria-label="打开 AI Hub"')).toBeLessThan(
      visible.indexOf('aria-label="打开浏览器直播"'),
    );
  });

  it("marks the appearance action active while its panel is open", () => {
    const html = renderToStaticMarkup(
      createElement(ChatHeaderActions, { ...baseProps, appearanceOpen: true }),
    );

    expect(html).toContain("chat-header-action--appearance is-active");
  });

  it("renders the Codex release action as an icon-only button", () => {
    const html = renderToStaticMarkup(createElement(ChatHeaderActions, {
      ...baseProps,
      onReleaseCodex: () => {},
    }));

    expect(html).toContain('aria-label="停止在 AgentRoam 中使用（Codex Desktop 最长约 30 分钟后可用）"');
    expect(html).toContain("chat-header-action--codex-release is-idle");
    expect(html).not.toContain(">停止在 AgentRoam 中使用<");
  });

  it("disables the Codex release action while releasing", () => {
    const html = renderToStaticMarkup(createElement(ChatHeaderActions, {
      ...baseProps,
      codexReleaseState: "releasing",
      onReleaseCodex: () => {},
    }));

    expect(html).toContain('aria-label="正在停止 AgentRoam 使用此会话"');
    expect(html).toContain("disabled");
  });

  it("states the Codex Desktop wait after AgentRoam stops using the session", () => {
    const html = renderToStaticMarkup(createElement(ChatHeaderActions, {
      ...baseProps,
      codexReleaseState: "released",
      onReleaseCodex: () => {},
    }));

    expect(html).toContain('aria-label="已停止在 AgentRoam 中使用；Codex Desktop 最长约 30 分钟后可用"');
    expect(html).not.toContain("可在 Codex 桌面端重试");
    expect(html).toContain("disabled");
  });
});

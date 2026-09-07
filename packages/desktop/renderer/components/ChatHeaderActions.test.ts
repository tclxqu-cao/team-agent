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

    expect(html).toContain('aria-label="交接到 Codex 桌面端"');
    expect(html).toContain("chat-header-action--codex-release is-idle");
    expect(html).not.toContain(">交接到 Codex 桌面端<");
  });

  it("disables the Codex release action while releasing", () => {
    const html = renderToStaticMarkup(createElement(ChatHeaderActions, {
      ...baseProps,
      codexReleaseState: "releasing",
      onReleaseCodex: () => {},
    }));

    expect(html).toContain('aria-label="正在释放 Codex 会话"');
    expect(html).toContain("disabled");
  });
});

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ResponsiveToolbar, { compactToolbarGroups, glassMobileToolbarActions } from "./ResponsiveToolbar";
import { CONSOLE_CSS } from "./console-styles";

describe("shared glass toolbar", () => {
  it("also gives classic glass mobile menus separate appearance cards without duplicating files", () => {
    const grouped = createElement("div", {}, "classic appearance controls");
    const actions = glassMobileToolbarActions([
      { id: "refresh", content: "refresh" },
      { id: "theme", content: grouped, compactItems: [
        { id: "theme", content: "skin" }, { id: "navigation-layout", content: "layout" },
      ] },
      { id: "files", content: "files" },
    ]);
    expect(actions.map(action => action.id)).toEqual(["refresh", "theme", "navigation-layout"]);
    expect(actions.map(action => action.content)).toEqual(["refresh", "skin", "layout"]);
    expect(glassMobileToolbarActions([])).toEqual([]);
    expect(glassMobileToolbarActions([{ id: "theme", content: grouped, compactItems: [] }])).toEqual([]);
  });

  it("splits skin and layout into adjacent independent cells without changing classic items", () => {
    const grouped = createElement("div", {}, "classic appearance controls");
    const items = [
      { id: "remote", content: "remote" },
      { id: "theme", content: grouped, compactItems: [
        { id: "theme", content: "skin" }, { id: "navigation-layout", content: "layout" },
      ] },
      { id: "files", content: "files" },
    ];
    const groups = compactToolbarGroups(items);
    expect(groups.map(group => group.map(item => item.id))).toEqual([["remote"], ["theme", "navigation-layout"], ["files"]]);
    expect(groups[1][0].content).toBe("skin");
    expect(groups[1][1].content).toBe("layout");
    expect(items[1].content).toBe(grouped);
    expect(compactToolbarGroups(items.filter(item => item.id !== "theme")).map(group => group.map(item => item.id))).toEqual([["remote"], ["files"]]);
    expect(compactToolbarGroups([{ id: "empty", content: null, compactItems: [] }])).toEqual([]);
  });

  it("keeps files beside the overflow trigger and avatar in the shared desktop layout", () => {
    const html = renderToStaticMarkup(createElement(ResponsiveToolbar, {
      avatar: createElement("button", { "aria-label": "电脑" }),
      items: [
        { id: "files", content: createElement("button", { "aria-label": "我的文件" }) },
        { id: "theme", content: "skin" },
      ],
    }));
    expect(html).toContain("glass-desktop-toolbar");
    expect(html).toContain('aria-label="更多功能"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="电脑"');
    expect(html).toContain('aria-label="我的文件"');
    expect(html).not.toContain('compact-toolbar');
  });

  it("does not render an empty overflow when all tools are hidden", () => {
    const html = renderToStaticMarkup(createElement(ResponsiveToolbar, { avatar: "", items: [] }));
    expect(html).not.toContain('aria-label="更多功能"');
  });

  it("keeps tool dialogs mounted when their menu is closed", () => {
    const toolbar = readFileSync(new URL("./ResponsiveToolbar.tsx", import.meta.url), "utf8");
    expect(toolbar).toContain('hidden={!overflowOpen} className="glass-desktop-menu"');
    expect(toolbar).toContain('hidden={!overflowOpen} className="glass-tools-backdrop"');
    expect(toolbar).not.toContain("overflowOpen && portalNode");
    expect(CONSOLE_CSS).toContain('.glass-desktop-menu[hidden], .glass-tools-backdrop[hidden] { display:none; }');
  });

  it("retains configured tool visibility while removing theme-specific layout branches", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page).not.toContain('compact={navigationLayout');
    expect(page).not.toContain('glass={themeId');
    expect(page).toContain('computerConfiguration.settings.visibleTools.some(id => id === item.id)');
  });
});

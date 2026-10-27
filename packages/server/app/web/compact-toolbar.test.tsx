import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ResponsiveToolbar, { compactToolbarGroups, glassMobileToolbarActions } from "./ResponsiveToolbar";
import { CONSOLE_CSS } from "./console-styles";

describe("rail layout compact toolbar", () => {
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

  it.each([true, false])("uses only the overflow trigger and avatar with glass=%s", glass => {
    const html = renderToStaticMarkup(createElement(ResponsiveToolbar, {
      glass, compact: true, avatar: createElement("button", { "aria-label": "电脑" }),
      items: [{ id: "files", content: createElement("button", { "aria-label": "我的文件" }) }],
    }));
    expect(html).toContain("compact-toolbar");
    expect(html).toContain('aria-label="更多功能"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="电脑"');
    expect(html).not.toContain('aria-label="我的文件"');
    expect(html).not.toContain('>更多功能<');
  });

  it("does not render an empty overflow when all tools are hidden", () => {
    const html = renderToStaticMarkup(createElement(ResponsiveToolbar, { compact: true, avatar: "", items: [] }));
    expect(html).not.toContain('aria-label="更多功能"');
  });

  it("backfills mobile grid gaps while keeping the skin and layout controls together", () => {
    expect(CONSOLE_CSS).toContain('grid-template-columns:repeat(3, minmax(0, 1fr)); grid-auto-flow:row dense;');
    expect(CONSOLE_CSS).toContain('.compact-tools-panel.is-mobile .compact-tools-group { display:grid; grid-column:span 2;');
  });

  it("enables compaction by layout without bypassing configured visibility or theme", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page).toContain('compact={navigationLayout === "agent-rail"}');
    expect(page).toContain('glass={themeId === "glass"}');
    expect(page).toContain('computerConfiguration.settings.visibleTools.some(id => id === item.id)');
    expect(CONSOLE_CSS).toContain('backdrop-filter:blur(22px) saturate(1.2)');
    expect(CONSOLE_CSS).toContain('.compact-tools-backdrop[hidden], .compact-tools-overlay[hidden] { display:none; }');
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./web.css", import.meta.url), "utf8");

describe("mobile sidebar spacing", () => {
  it("retains the original full-column agent selection", () => {
    expect(css).toMatch(/\.agent-workspace-switcher:not\(\.is-vertical\) button \{\s*min-inline-size: 44px;\s*block-size: 44px;\s*border-radius: 9px;/);
  });
  it("packs directory actions without overlapping their touch targets", () => {
    expect(css).toMatch(/\.sidebar-project-actions \{\s*gap: 0;/);
    expect(css).toMatch(/\.sidebar-project-actions \.ui-icon-button \{\s*width: 32px;\s*height: 32px;\s*border-radius: 8px;\s*flex: 0 0 32px;/);
  });
  it("aligns the agent rail and search, shows all five agents and hides desktop shortcuts", () => {
    expect(css).toContain("grid-auto-columns: calc((100% - 16px) / 5)");
    expect(css).toContain("margin: 0 12px 10px");
    expect(css).toContain("width: calc(100% - 24px)");
    expect(css).toMatch(/\.sidebar-search-field kbd \{\s*display: none;/);
    expect(css).toMatch(/\.agent-workspace-more \{\s*display: none;/);
  });
  it("removes stacked row spacing while keeping 44px main targets", () => {
    expect(css).toMatch(/\.app-sidebar \.sidebar-row \{\s*min-height: 44px;\s*margin: 0;\s*border-width: 0;/);
    expect(css).toMatch(/\.app-sidebar \.sidebar-project-block \{\s*margin-bottom: 0;/);
    expect(css).toMatch(/\.sidebar-row > button:first-child \{\s*min-height: 44px;/);
  });

  it("retains child indentation and touch action sizes", () => {
    expect(css).toMatch(/\.sidebar-session-row--child \{\s*margin-left: 14px;\s*border-left-width: 1px;/);
    expect(css).toMatch(/\.app-sidebar \.ui-icon-button--small \{\s*width: 42px;\s*height: 42px;/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shared = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");
const web = readFileSync(new URL("../../../webapp/src/presentation/web.css", import.meta.url), "utf8");
const navigation = shared.slice(shared.indexOf("/* Shared workspace navigation;"));

describe("shared workspace navigation across phone, tablet and desktop", () => {
  it("shares the Agent rail, search, directory rows and actions without a viewport gate", () => {
    expect(navigation).not.toContain("@media");
    expect(navigation).not.toContain("data-web-shell");
    for (const selector of [".agent-workspace-track", ".sidebar-search-field", ".sidebar-project-toolbar", ".sidebar-row-action"]) {
      expect(navigation).toContain(selector);
      expect(web).not.toContain(`body[data-web-shell="1"] .app-sidebar ${selector}`);
    }
    expect(navigation).toContain("grid-auto-columns: calc((100% - 16px) / 5)");
    expect(navigation).toContain("min-inline-size: 0");
    expect(navigation).toContain("min-height: 44px");
  });

  it("reserves window chrome space only in the native desktop shell", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(app).toContain('padding: webShell ? "12px 0 0" : "56px 0 0"');
    expect(app).toContain('{!webShell && <div className="sidebar-window-drag-region"');
  });

  it("keeps drawer sizing and desktop window chrome out of shared navigation", () => {
    expect(web).toContain("width: min(88vw, 348px)");
    expect(navigation).not.toContain("88vw");
    expect(navigation).not.toContain(".sidebar-window-drag-region");
    expect(navigation).toContain(".agent-workspace-switcher:not(.is-vertical)");
  });
});

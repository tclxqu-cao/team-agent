import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./browser-composer.css", import.meta.url), "utf8");

const addMenuStart = css.indexOf(".web-native-add-menu {");
const addMenuCss = css.slice(
  addMenuStart,
  css.indexOf(".web-native-send-button {", addMenuStart),
);

describe("browser composer add menu theme", () => {
  it("uses semantic skin tokens instead of fixed light colors", () => {
    expect(addMenuCss).toContain("border: 1px solid var(--border-default)");
    expect(addMenuCss).toContain("background: var(--bg-elevated)");
    expect(addMenuCss).toContain("box-shadow: var(--shadow-md)");
    expect(addMenuCss).toContain("color: var(--text-primary)");
    expect(addMenuCss).toContain("background: var(--control-hover)");
    expect(addMenuCss).toContain("background: var(--control-active)");

    expect(addMenuCss).not.toContain("background: #fff");
    expect(addMenuCss).not.toContain("color: #111827");
    expect(addMenuCss).not.toContain("rgba(17,24,39");
  });
});

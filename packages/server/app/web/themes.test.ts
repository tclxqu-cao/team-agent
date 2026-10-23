import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_ID, resolveWebTheme, WEB_THEMES } from "./themes";
import { SKINS } from "../../../desktop/renderer/stores/uiStore";

describe("web skin registry", () => {
  it("keeps the shell and renderer skin registries aligned", () => {
    expect(WEB_THEMES.map((theme) => theme.id).sort()).toEqual(SKINS.map((skin) => skin.id).sort());
  });

  it("resolves glass without changing the default or terminal readability", () => {
    const theme = resolveWebTheme("glass");
    expect(theme.label).toBe("毛玻璃");
    expect(theme.cssVars["--ui-color-scheme"]).toBe("light");
    expect(theme.xterm.background).toBe("#ffffff");
    expect(DEFAULT_THEME_ID).toBe("pearl");
    expect(resolveWebTheme("unknown").id).toBe("pearl");
  });
});

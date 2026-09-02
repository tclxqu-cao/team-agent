import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("web terminal surface styling", () => {
  it("joins the active tab to its content surface", () => {
    expect(pageSource).toContain('"--ui-active-content-bg": activeContentBackground');
    expect(pageSource).toMatch(/\.terminal-tabs\s*\{[^}]*border-bottom:0;/);
    expect(pageSource).toMatch(
      /\.terminal-tab\.active\s*\{[^}]*background:var\(--ui-active-content-bg/,
    );
    expect(pageSource).not.toMatch(/\.terminal-tab\s*\{[^}]*transition:[^;}]*background/);
  });

  it("replaces xterm's default black viewport with the terminal theme", () => {
    expect(pageSource).toContain('"--ui-terminal-bg": activeTheme.termHostBg');
    expect(pageSource).toMatch(
      /\.terminal-screen \.xterm \.xterm-viewport\s*\{[^}]*background-color:var\(--ui-terminal-bg/,
    );
  });
});

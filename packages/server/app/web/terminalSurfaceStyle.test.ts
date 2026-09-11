import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("web terminal surface styling", () => {
  it("prevents command and search input focus zoom while preserving compact row heights", () => {
    const mobileInputs = pageSource.match(/@media \(max-width:768px\), \(pointer:coarse\)\s*\{([\s\S]*?)\n  \}/)?.[1];
    expect(mobileInputs).toContain(".pinned-command-editor input, .history-search input, .tree-filter input { font-size:16px; }");
    expect(mobileInputs).not.toContain(".tree-location input");
    expect(mobileInputs).not.toContain("min-height");
    expect(pageSource).toMatch(/\.tree-location input\s*\{[^}]*height: 28px;[^}]*font-size: 10\.5px;/);
    expect(pageSource).toMatch(/\.tree-filter input\s*\{[^}]*height: 27px;[^}]*font-size: 11px;/);
    expect(pageSource).toMatch(/\.pinned-command-editor input\s*\{[^}]*height:27px;/);
    expect(pageSource).toContain(".terminal-screen .xterm-helper-textarea { font-size:16px !important; }");
    expect(pageSource).toMatch(/\.terminal-native-touch \.xterm-helper-textarea\s*\{[^}]*font-size:16px/);
  });
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

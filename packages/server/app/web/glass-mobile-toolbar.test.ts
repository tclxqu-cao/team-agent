import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toolbar = readFileSync(new URL("./ResponsiveToolbar.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./neural-boot.css", import.meta.url), "utf8");

describe("glass mobile toolbar isolation", () => {
  it("positions the desktop menu using its actual width and observes size changes", () => {
    expect(toolbar).toContain('overflow.current?.getBoundingClientRect().width');
    expect(toolbar).toContain('if (glassDesktop && overflow.current) observer.observe(overflow.current)');
    expect(css).toContain('.glass-desktop-menu { box-sizing: border-box; width: max-content;');
    expect(css).toContain(':is(.glass-desktop-actions, .glass-desktop-menu) button svg { width: 20px; height: 20px; }');
  });
  it("keeps desktop glass tools together at the right and tabs at the left", () => {
    expect(toolbar).toContain("const glassDesktop = glass && !mobile");
    expect(toolbar).toContain('const primary = ["files", "remote"]');
    expect(toolbar).toContain('const secondary = items.filter(item => !["files", "remote"].includes(item.id))');
    const desktop = css.slice(css.indexOf("@media (min-width: 900px)"));
    expect(desktop).toContain('.terminal-connection { flex: 0 0 auto; min-width: 0; margin-left: auto;');
    expect(desktop).toContain('.glass-desktop-toolbar > .toolbar-avatar { margin-left: 0;');
    expect(desktop).toContain('background: transparent;');
  });
  it("uses compact icon-only actions while retaining names", () => {
    expect(toolbar).not.toContain('<span>{labels[item.id] ?? item.id}</span>');
    expect(toolbar).toContain('title={labels[item.id] ?? item.id}');
    expect(toolbar).not.toContain("LogOut");
    expect(toolbar).not.toContain("chat-header-action--codex-release");
    expect(css).toContain('.glass-tool-cell button svg { width: 20px; height: 20px; }');
  });
  it("requires both the glass theme and mobile viewport", () => {
    expect(page).toContain('glass={themeId === "glass"}');
    expect(toolbar).toContain("const glassMobile = glass && mobile");
    expect(toolbar).toContain('window.matchMedia("(max-width: 899px)")');
    expect(toolbar).toContain("if (glassMobile)");
  });
  it("reuses original actions without adding session release", () => {
    expect(toolbar).toContain("{item.content}");
    expect(toolbar).not.toContain("window.confirm(");
    expect(toolbar).not.toContain("createPortal(controls, headerTarget)");
    expect(toolbar).toContain("{controls}\n      <div className=\"toolbar-avatar\">");
    expect(toolbar).toContain("querySelector<HTMLButtonElement>");
  });
  it("keeps global files in the shell toolbar instead of the session header portal", () => {
    const controls = toolbar.slice(toolbar.indexOf("const controls ="), toolbar.indexOf('return <div ref={root} className="responsive-toolbar glass-mobile-toolbar"'));
    expect(controls).not.toContain('item.id === "files"');
    expect(toolbar).toContain('className="responsive-toolbar glass-mobile-toolbar">\n      {items.filter(item => item.id === "files").map(renderItem)}');
  });
  it("centers tabs and removes legacy active decoration on mobile glass", () => {
    const mobile = css.slice(css.indexOf("@media (max-width: 899px)"));
    expect(mobile).toMatch(/\.terminal-tabs\s*\{[^}]*align-items: center/s);
    expect(mobile).toMatch(/\.terminal-tab-list\s*\{[^}]*height: auto;[^}]*align-items: center/s);
    expect(mobile).toMatch(/\.terminal-tab\.active\s*\{[^}]*box-shadow: none/s);
    expect(mobile).toMatch(/\.terminal-add\s*\{[^}]*margin: 0/s);
  });
  it("scopes mobile CSS to glass", () => {
    const mobile = css.slice(css.indexOf("@media (max-width: 899px)"));
    expect(mobile).toContain('[data-web-theme="glass"] .terminal-tabs');
    expect(mobile).toContain('[data-web-theme="glass"] .glass-tools-sheet');
  });
});

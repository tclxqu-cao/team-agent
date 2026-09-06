import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("web console file drawer layout", () => {
  it("keeps drawer display in CSS so the desktop closed state can hide it", () => {
    const treeColStyles = pageSource.match(/treeCol:\s*\{([\s\S]*?)\n  \},/)?.[1] ?? "";
    const workspaceStyles = pageSource.match(/workspace:\s*\{([\s\S]*?)\n  \},/)?.[1] ?? "";

    expect(treeColStyles).not.toMatch(/\bdisplay\s*:/);
    expect(workspaceStyles).not.toMatch(/\bgridTemplateColumns\s*:/);
    expect(pageSource).toMatch(/\.tree-col\s*\{\s*display:\s*flex;/);
    expect(pageSource).toMatch(/\.workspace:not\(\.show-tree\) \.tree-col\s*\{\s*display:\s*none;/);
    expect(pageSource).toMatch(/\.workspace\.show-tree:not\(\.has-preview\)\s*\{\s*grid-template-columns:\s*80% 20%;/);
    expect(pageSource).toMatch(/\.workspace\.show-tree\.has-preview\s*\{\s*grid-template-columns:\s*46% 20% 34%;/);
    expect(pageSource).toMatch(/\.workspace\.has-preview:not\(\.show-tree\)\s*\{\s*grid-template-columns:\s*66% 34%;/);
    expect(pageSource).not.toMatch(/grid-template-columns:\s*1fr minmax\(220px, 264px\)/);
    expect(pageSource).toContain('className="file-drawer-toggle"');
    expect(pageSource).toContain('<PanelRight size={17} aria-hidden="true" />');
    expect(pageSource).toContain('aria-label={drawerOpen ? "关闭我的文件" : "打开我的文件"}');
    expect(pageSource).toContain('onClick={() => setDrawerOpen((open) => !open)}');
    expect(pageSource).not.toContain('className="fab-files"');
    expect(pageSource).not.toContain("fileButtonPosition");
    expect(pageSource).toContain('className="theme-avatar-with-status"');
    expect(pageSource).toContain('className="theme-avatar-status"');
    expect(pageSource).toContain('aria-label={state.connected ? "已连接" : "未连接"}');
    expect(pageSource).toContain('.theme-avatar-status[data-connected="true"]');
    expect(pageSource).toMatch(/\.theme-avatar \{[^}]*width:18px; height:18px;/);
    expect(pageSource).toMatch(/@media \(pointer: coarse\)[\s\S]*\.theme-avatar::after \{ inset:-9px; \}/);
  });

  it("only casts the mobile drawer shadow while the drawer is open", () => {
    const closedTreeColStyles = pageSource.match(/\.tree-col\s*\{([\s\S]*?)\n  \}/)?.[1] ?? "";

    expect(closedTreeColStyles).not.toContain("box-shadow");
    expect(pageSource).toMatch(
      /\.tree-col-open\s*\{[^}]*box-shadow:\s*-12px 0 32px rgba\(0,0,0,\.5\);[^}]*\}/,
    );
  });

  it("opens, previews, and reveals artifact requests from the expected Web App frame", () => {
    expect(pageSource).toContain("readWebArtifactOpenRequest(");
    expect(pageSource).toContain('setDrawerTab("files")');
    expect(pageSource).toContain("setDrawerOpen(true)");
    expect(pageSource).toContain("setPreviewPath(artifactRequest.path)");
    expect(pageSource).toContain("setFileTreeRevealRequest(artifactRequest)");
    expect(pageSource).toContain("revealRequest={fileTreeRevealRequest}");
    expect(pageSource).toContain("webappFrameRef.current?.contentWindow ?? null");
    expect(pageSource).toContain("setDrawerOpen(false); // picking a file dismisses the drawer on phones");
  });
});

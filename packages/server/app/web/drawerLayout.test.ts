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
    expect(pageSource).toMatch(/\{!drawerOpen && <button className="fab-files"/);
    expect(pageSource).not.toMatch(/\.fab-files\s*\{\s*display:\s*none;/);
    expect(pageSource).toMatch(/Math\.hypot\([^)]*drag\.startX[^)]*drag\.startY[^)]*\)<4/);
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

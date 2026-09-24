import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const desktopStyles = readFileSync(new URL("../../styles/global.css", import.meta.url), "utf8");
const filePreviewSource = readFileSync(new URL("./FilePreview.tsx", import.meta.url), "utf8");

describe("Electron file workspace layout", () => {
  it("enables the dock grid only when the Electron gateway exists", () => {
    expect(appSource).toContain('fileWorkspaceGateway ? " file-workspace-capable" : ""');
    expect(appSource).toContain('fileDrawerOpen && fileWorkspaceGateway ? " file-workspace-open" : ""');
    expect(appSource).toContain('fileDrawerOpen && fileWorkspaceGateway && filePreviewPath ? " file-workspace-preview-open" : ""');
    expect(desktopStyles).toContain(".app-main.file-workspace-capable {");
    expect(desktopStyles).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(desktopStyles).toContain(".app-main.file-workspace-capable.file-workspace-open {");
  });

  it("uses an adjacent dock column without overlay or chat spacing compensation", () => {
    const workspaceStyles = desktopStyles.match(/\.desktop-file-workspace \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const drawerHeaderStyles = desktopStyles.match(/\.desktop-file-drawer-header \{([\s\S]*?)\}/)?.[1] ?? "";
    const dockStyles = desktopStyles.match(/\.app-main\.file-workspace-capable \{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(workspaceStyles).not.toMatch(/position:\s*absolute/);
    expect(workspaceStyles).not.toMatch(/\binset:/);
    expect(workspaceStyles).not.toMatch(/box-shadow/);
    expect(drawerHeaderStyles).toMatch(/-webkit-app-region:\s*no-drag/);
    expect(dockStyles).toMatch(/display:\s*grid/);
    expect(desktopStyles).not.toMatch(/\.app-main[^\n{]*file-workspace[^\n{]*\.app-chat-surface[^}]*margin-right/);
  });

  it("maps shared preview controls onto the active desktop skin", () => {
    const workspaceStyles = desktopStyles.match(/\.desktop-file-workspace \{([\s\S]*?)\n\}/)?.[1] ?? "";

    expect(workspaceStyles).toMatch(/--ui-tab-bg:\s*var\(--bg-deep\)/);
    expect(workspaceStyles).toMatch(/--ui-muted-surface:\s*var\(--bg-deep\)/);
    expect(workspaceStyles).toMatch(/--ui-muted-text:\s*var\(--text-secondary\)/);
    expect(workspaceStyles).toMatch(/--ui-muted-border:\s*var\(--border-default\)/);
  });

  it("keeps file preview header buttons outside the Electron drag region", () => {
    const headerButtonStyles = filePreviewSource.match(
      /const HEADER_BUTTON_STYLES: React\.CSSProperties(?: & \{ WebkitAppRegion: string \})? = \{([\s\S]*?)\n\};/,
    )?.[1] ?? "";

    expect(headerButtonStyles).toMatch(/WebkitAppRegion:\s*"no-drag"/);
  });

  it("does not take ownership of the WebApp drawer selectors", () => {
    expect(desktopStyles).not.toContain(".workspace.show-tree");
    expect(desktopStyles).not.toMatch(/(^|\n)\s*\.tree-col(?:\s|\{|\.|:)/);
    expect(desktopStyles).not.toMatch(/(^|\n)\s*\.preview-col(?:\s|\{|\.|:)/);
  });
});

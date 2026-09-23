import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDesktopDirectoryContextMenuPath } from "./sidebar-directory-context-menu";

const available = { isInvalid: false, supported: true, webShell: false };

describe("sidebar directory context menu", () => {
  it("offers the desktop action for local project directories", () => {
    expect(getDesktopDirectoryContextMenuPath({ description: "/Users/test/project" }, available))
      .toBe("/Users/test/project");
    expect(getDesktopDirectoryContextMenuPath({ description: "C:\\work\\project" }, available))
      .toBe("C:\\work\\project");
  });

  it("does not offer the action for virtual, invalid, web, or unsupported rows", () => {
    expect(getDesktopDirectoryContextMenuPath({ description: "" }, available)).toBeNull();
    expect(getDesktopDirectoryContextMenuPath({ description: "codex:recent" }, available)).toBeNull();
    expect(getDesktopDirectoryContextMenuPath({ description: "/missing" }, { ...available, isInvalid: true })).toBeNull();
    expect(getDesktopDirectoryContextMenuPath({ description: "/workspace" }, { ...available, webShell: true })).toBeNull();
    expect(getDesktopDirectoryContextMenuPath({ description: "/workspace" }, { ...available, supported: false })).toBeNull();
  });

  it("keeps the renderer, preload, shared proxy, and main IPC wiring connected", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../../main/preload.ts", import.meta.url), "utf8");
    const main = readFileSync(new URL("../../main/index.ts", import.meta.url), "utf8");
    const shared = readFileSync(new URL("./shared-service.ts", import.meta.url), "utf8");

    expect(app).toContain("onContextMenu={(event) => handleProjectContextMenu(event, project, isInvalid)}");
    expect(preload).toContain('showDirectoryContextMenu: (path: string) => ipcRenderer.invoke("directory:show-context-menu", path)');
    expect(main).toContain('ipcMain.handle("directory:show-context-menu"');
    expect(shared).toContain('"showDirectoryContextMenu"');
  });
});

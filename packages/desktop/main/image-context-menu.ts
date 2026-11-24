import type { BrowserWindow, Menu } from "electron";

export function installImageContextMenu(window: BrowserWindow, buildMenu: typeof Menu.buildFromTemplate): void {
  const contents = window.webContents;
  contents.on("context-menu", (_event, { mediaType, hasImageContents, x, y }) => {
    if (mediaType !== "image" || !hasImageContents) return;
    buildMenu([{
      label: "复制图片",
      click: () => {
        if (!contents.isDestroyed()) contents.copyImageAt(x, y);
      },
    }]).popup({ window });
  });
}

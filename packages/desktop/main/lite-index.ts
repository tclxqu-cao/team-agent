import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installGlobalLogging } from "@agent/core";
import { SharedServiceConnection } from "./shared-service.js";
import { DesktopRuntimeBootstrap } from "./runtime-bootstrap.js";
import { DesktopLiveCliProxy } from "./desktop-live-cli-proxy.js";
import { LitePairingService } from "./lite-pairing.js";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, Menu } = require("electron") as typeof import("electron");
app.setName("AgentRoam Lite");
if (process.env.AGENTROAM_DESKTOP_USER_DATA?.trim()) app.setPath("userData", resolve(process.env.AGENTROAM_DESKTOP_USER_DATA));
const logger = installGlobalLogging({ dir: join(app.getPath("userData"), "logs"), source: "desktop-lite", minLevel: "info", handlers: { exitOnUncaughtException: false } });
logger.info("desktop lite main booting", { version: app.getVersion(), platform: process.platform });
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
const directory = fileURLToPath(new URL(".", import.meta.url));
const service = new SharedServiceConnection(join(app.getPath("userData"), "shared-service.json"));
const bootstrap = new DesktopRuntimeBootstrap(app.isPackaged, process.resourcesPath);
const pairing = new LitePairingService(service, bootstrap);
const remote = new DesktopLiveCliProxy({ request: (path, method, body) => service.json(path, method, body) });
let window: import("electron").BrowserWindow | null = null;

function trusted(event: import("electron").IpcMainInvokeEvent): void {
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("Untrusted desktop sender");
}
ipcMain.handle("lite:refresh", async event => {
  trusted(event);
  const invitation = await pairing.refresh();
  logger.info("lite QR invitation ready");
  return invitation;
});
ipcMain.handle("lite:progress", event => { trusted(event); return bootstrap.status(); });
ipcMain.handle("lite:authorization", (event, action: unknown, permission: unknown) => {
  trusted(event);
  if (action === "status") return remote.refresh();
  if (action === "enable" || action === "recheck" || action === "restart") return remote.action(action);
  if (action === "authorize" && (permission === "screen" || permission === "accessibility")) return remote.action(action, permission);
  throw new Error("Invalid authorization action");
});

function createWindow(): void {
  window = new BrowserWindow({ width: 480, height: 760, minWidth: 400, minHeight: 680, title: "AgentRoam Lite · 手机连接", backgroundColor: "#0c141a", autoHideMenuBar: true,
    webPreferences: { preload: join(directory, "lite-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("render-process-gone", (_event, details) => logger.error("lite renderer process gone", undefined, { reason: details.reason, exitCode: details.exitCode }));
  window.webContents.on("preload-error", (_event, _path, error) => logger.error("lite preload failed", error));
  window.webContents.on("did-finish-load", () => logger.info("lite renderer loaded"));
  window.on("closed", () => { window = null; });
  void window.loadFile(join(directory, "../../renderer-lite-dist/lite.html"));
}
app.on("second-instance", () => { window?.restore(); window?.show(); window?.focus(); });
app.whenReady().then(async () => {
  await service.initialize();
  app.setAccessibilitySupportEnabled(true);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "AgentRoam Lite", submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] }, { role: "editMenu" }, { role: "windowMenu" }]));
  createWindow();
}).catch(error => { logger.error("lite startup failed", error); app.quit(); });
app.on("activate", () => { if (!window) createWindow(); else { window.show(); window.focus(); } });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
// The CLI owns the service: closing this QR window must never stop phone sessions.
app.on("before-quit", () => { remote.close(); service.closeStreams(); });

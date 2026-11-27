"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("liteApi", {
    refresh: () => electron_1.ipcRenderer.invoke("lite:refresh"),
    progress: () => electron_1.ipcRenderer.invoke("lite:progress"),
    tunnelStatus: () => electron_1.ipcRenderer.invoke("lite:tunnel-status"),
    connectTunnel: () => electron_1.ipcRenderer.invoke("lite:tunnel-connect"),
    authorization: (action, permission) => electron_1.ipcRenderer.invoke("lite:authorization", action, permission),
});

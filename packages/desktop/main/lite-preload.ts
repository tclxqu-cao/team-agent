import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("liteApi", {
  refresh: (route?: string) => ipcRenderer.invoke("lite:refresh", route),
  pairingRoutes: () => ipcRenderer.invoke("lite:pairing-routes"),
  progress: () => ipcRenderer.invoke("lite:progress"),
  tunnelStatus: () => ipcRenderer.invoke("lite:tunnel-status"),
  connectTunnel: () => ipcRenderer.invoke("lite:tunnel-connect"),
  authorization: (action: string, permission?: string) => ipcRenderer.invoke("lite:authorization", action, permission),
});

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("liteApi", {
  getUpdateStatus: () => ipcRenderer.invoke("update:get-status"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },
  refresh: (route?: string) => ipcRenderer.invoke("lite:refresh", route),
  pairingRoutes: () => ipcRenderer.invoke("lite:pairing-routes"),
  progress: () => ipcRenderer.invoke("lite:progress"),
  tunnelStatus: () => ipcRenderer.invoke("lite:tunnel-status"),
  connectTunnel: () => ipcRenderer.invoke("lite:tunnel-connect"),
  authorization: (action: string, permission?: string) => ipcRenderer.invoke("lite:authorization", action, permission),
});

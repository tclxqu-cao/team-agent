import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("liteApi", {
  refresh: () => ipcRenderer.invoke("lite:refresh"),
  progress: () => ipcRenderer.invoke("lite:progress"),
  tunnelStatus: () => ipcRenderer.invoke("lite:tunnel-status"),
  connectTunnel: () => ipcRenderer.invoke("lite:tunnel-connect"),
  authorization: (action: string, permission?: string) => ipcRenderer.invoke("lite:authorization", action, permission),
});

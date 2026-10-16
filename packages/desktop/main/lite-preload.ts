import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("liteApi", {
  refresh: () => ipcRenderer.invoke("lite:refresh"),
  progress: () => ipcRenderer.invoke("lite:progress"),
  authorization: (action: string, permission?: string) => ipcRenderer.invoke("lite:authorization", action, permission),
});

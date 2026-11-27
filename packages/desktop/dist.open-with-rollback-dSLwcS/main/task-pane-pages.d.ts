import type { BrowserWindow, IpcMain } from "electron";
import type { AIHubManager } from "./ai-hub/manager.js";
export declare function taskPanePageId(value: unknown): string | null;
export declare function taskPanePageUrl(value: unknown): string | null;
export declare function taskPanePageRect(value: unknown): {
    x: number;
    y: number;
    width: number;
    height: number;
} | null;
/** Native website panes never receive Node integration or access to the host renderer's IPC. */
export declare function registerTaskPanePageIpc(ipc: IpcMain, manager: AIHubManager, getWindow: () => BrowserWindow | null): void;
//# sourceMappingURL=task-pane-pages.d.ts.map
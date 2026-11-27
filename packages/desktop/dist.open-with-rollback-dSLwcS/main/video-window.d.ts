import type { BrowserWindow } from "electron";
import type { DesktopFileWorkspaceService } from "./file-workspace-service.js";
export interface OpenVideoWindowOptions {
    source: string;
    remote: boolean;
    title: string;
    currentTime: number;
    playing: boolean;
}
export declare function openVideoWindow(Window: typeof BrowserWindow, files: Pick<DesktopFileWorkspaceService, "request">, raw: unknown, opener: BrowserWindow | null): Promise<void>;
//# sourceMappingURL=video-window.d.ts.map
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
export declare function newSessionWindowQuery(value: unknown): Record<string, string>;
/** Only app-owned renderer main frames share the broker; each owns its SSE handles. */
export declare class DesktopRendererWindows {
    private readonly stop;
    private readonly windows;
    constructor(stop: (id: string) => void);
    register(window: BrowserWindow): void;
    assertSender(event: IpcMainInvokeEvent): void;
    streamId(event: IpcMainInvokeEvent, id: string): string;
    stopStream(event: IpcMainInvokeEvent, id: string): void;
}
//# sourceMappingURL=new-session-window.d.ts.map
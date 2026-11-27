import type { DesktopInputCommand } from "../desktop-input-gateway.js";
import type { DesktopCapturedFrame } from "../desktop-screen-screencast.js";
export interface ComputerInputGateway {
    dispatch(command: DesktopInputCommand): Promise<unknown>;
}
export declare function screenshotPoint(frame: DesktopCapturedFrame, x: number, y: number): {
    x: number;
    y: number;
};
export declare class DesktopInputAdapter {
    private readonly gateway;
    constructor(gateway: ComputerInputGateway);
    move(x: number, y: number): Promise<unknown>;
    click(x: number, y: number, button?: "left" | "right" | "middle", count?: number): Promise<void>;
    scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
    type(text: string): Promise<unknown>;
    keypress(keys: string[]): Promise<void>;
    drag(start: {
        x: number;
        y: number;
    }, end: {
        x: number;
        y: number;
    }, durationMs: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<void>;
}
//# sourceMappingURL=desktop-input-adapter.d.ts.map
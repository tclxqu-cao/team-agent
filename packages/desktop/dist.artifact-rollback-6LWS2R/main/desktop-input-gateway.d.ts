import type { AccessibilitySnapshotResult } from "@agent/computer-use";
export type DesktopInputCommand = {
    op: "move" | "down" | "up" | "drag" | "hit-test";
    x: number;
    y: number;
    button?: "left" | "right" | "middle";
    click?: number;
} | {
    op: "wheel";
    deltaX: number;
    deltaY: number;
} | {
    op: "key";
    action: "down" | "up";
    code: string;
    modifiers?: string[];
} | {
    op: "text" | "unicode_text";
    text: string;
} | {
    op: "ax_snapshot";
} | {
    op: "ax_action";
    revision: string;
    nodeId: string;
    action: "press" | "focus";
} | {
    op: "ax_text";
    revision: string;
    nodeId: string;
    text: string;
    replace: boolean;
};
export interface InputGatewayProcess {
    stdin: {
        write(chunk: string): void;
    };
    stdout: {
        on(event: "data", listener: (chunk: Buffer | string) => void): void;
    };
    stderr: {
        on(event: "data", listener: (chunk: Buffer | string) => void): void;
    };
    on(event: "exit", listener: (code: number | null) => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    kill(): void;
}
export type SpawnInputHelper = (path: string) => InputGatewayProcess;
/** Gateway to the desktop-input Swift helper: JSON-lines requests over stdin/stdout. */
export declare class DesktopInputGateway {
    #private;
    private readonly helperPath;
    private readonly spawnImpl;
    private readonly lineTimeoutMs;
    private readonly startSettleMs;
    private process;
    private buffer;
    private sequence;
    private readonly pending;
    private startPromise;
    private readonly onStderr;
    constructor({ helperPath, spawnImpl, lineTimeoutMs, startSettleMs, onStderr }: {
        helperPath: string;
        spawnImpl?: SpawnInputHelper;
        lineTimeoutMs?: number;
        startSettleMs?: number;
        onStderr?: (line: string) => void;
    });
    start(): Promise<void>;
    stop(): Promise<void>;
    checkAccessibility(): Promise<boolean>;
    snapshotAccessibility(): Promise<AccessibilitySnapshotResult>;
    performAccessibilityAction(revision: string, nodeId: string, action: "press" | "focus"): Promise<void>;
    setAccessibilityText(revision: string, nodeId: string, text: string, replace: boolean): Promise<void>;
    dispatch(command: DesktopInputCommand): Promise<Record<string, unknown>>;
    request(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}
//# sourceMappingURL=desktop-input-gateway.d.ts.map
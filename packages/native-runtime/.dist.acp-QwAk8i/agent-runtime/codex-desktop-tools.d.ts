export interface DesktopTurn {
    id: string;
    status: string;
    error?: {
        message?: string;
    } | null;
    items: Array<{
        id?: string;
        type: string;
        text?: string;
        phase?: string;
        content?: Array<{
            type: string;
            text?: string;
        }>;
    }>;
}
export interface DesktopThreadSnapshot {
    thread: {
        id: string;
        kind: string;
        cwd?: string;
        status?: {
            type: string;
            activeFlags?: string[];
        };
    };
    turns: DesktopTurn[];
}
export interface CodexDesktopConnection {
    read(): Promise<DesktopThreadSnapshot>;
    send(prompt: string, options?: {
        model?: string;
        thinking?: string;
        callId?: string;
    }): Promise<void>;
    close(): void;
}
/** Borrow the running Desktop's app tools; never create a second thread writer. */
export declare class CodexDesktopTools {
    private readonly options;
    constructor(options?: {
        environment?: NodeJS.ProcessEnv;
        platform?: NodeJS.Platform;
        pipePaths?: () => Promise<string[]>;
        timeoutMs?: number;
    });
    connect(threadId: string, cwd: string): Promise<CodexDesktopConnection | null>;
}
//# sourceMappingURL=codex-desktop-tools.d.ts.map
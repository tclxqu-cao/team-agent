export interface ZCodeDesktopTarget {
    id: string;
    cwd: string;
    workspaceIdentity?: string;
    readOnly?: boolean;
}
export interface ZCodeDesktopGuide {
    available(session: ZCodeDesktopTarget): Promise<boolean>;
    read?(session: ZCodeDesktopTarget): Promise<Record<string, unknown>>;
    steer(session: ZCodeDesktopTarget, input: string, messageId?: string): Promise<boolean>;
}
/** Borrow the desktop owner. This client never resumes or spawns its session. */
export declare class ZCodeDesktopBridge implements ZCodeDesktopGuide {
    private readonly options;
    private readonly directory;
    private readonly guides;
    private readonly owners;
    constructor(options?: {
        directory?: string;
        isAlive?: (pid: number) => boolean;
    });
    private descriptors;
    private request;
    private owner;
    available(session: ZCodeDesktopTarget): Promise<boolean>;
    read(session: ZCodeDesktopTarget): Promise<Record<string, unknown>>;
    steer(session: ZCodeDesktopTarget, input: string, messageId?: string): Promise<boolean>;
}
//# sourceMappingURL=zcode-desktop-bridge.d.ts.map
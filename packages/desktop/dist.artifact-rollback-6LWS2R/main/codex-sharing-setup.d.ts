interface SetupContext {
    request: (body: string) => Promise<{
        status: number;
        body: string;
    }>;
    confirm: () => Promise<boolean>;
    report: (message: string) => void;
}
export declare class DesktopCodexSharingSetup {
    private readonly context;
    private completed;
    private pending;
    constructor(context: SetupContext);
    prepare(): Promise<void>;
    private run;
}
export {};
//# sourceMappingURL=codex-sharing-setup.d.ts.map
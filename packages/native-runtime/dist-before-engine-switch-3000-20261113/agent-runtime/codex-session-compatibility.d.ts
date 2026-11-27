import type { AgentRuntimeAdapter, UnifiedSessionDetail, UnifiedSessionSummary } from "./types.js";
import { CodexSessionDiskCatalog } from "./codex-session-disk-catalog.js";
export declare class CodexSessionCompatibilityService {
    private readonly adapter;
    private readonly catalog;
    private onCompatibilityChanged;
    private primaryNativeSessionIds;
    private readonly pendingProbes;
    private probing;
    private disposed;
    constructor(adapter: AgentRuntimeAdapter, catalog: CodexSessionDiskCatalog, onCompatibilityChanged?: () => void);
    setOnCompatibilityChanged(callback: () => void): void;
    start(): void;
    supplement(primary: readonly UnifiedSessionSummary[]): UnifiedSessionSummary[];
    registerPrimary(nativeSessionId: string): void;
    isSupplemental(nativeSessionId: string): boolean;
    readSupplemental(nativeSessionId: string): Promise<UnifiedSessionDetail>;
    dispose(): void;
    private enqueueProbe;
    private drainProbes;
    private probeEntry;
    private isCurrentEntry;
    private incompatibleError;
}
//# sourceMappingURL=codex-session-compatibility.d.ts.map
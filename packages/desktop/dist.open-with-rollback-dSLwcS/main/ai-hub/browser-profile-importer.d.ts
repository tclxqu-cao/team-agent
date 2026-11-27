import { readKeychainSecret, type ChromiumCookieRow, type ElectronCookieDetails } from "./cookie-migration.js";
import { type BrowserProfileSourceId } from "./browser-profile-source.js";
import { ProfileImportStateStore, type ProfileImportErrorCategory } from "./import-state.js";
export declare const HUB_PROFILE_DIR_NAME = "ai-hub-browser-profile";
export type ProfileImportPhase = "checking" | "copying" | "importing-cookies" | "validating" | "complete";
export interface BrowserProfileImportResult {
    ok: boolean;
    sourceId: BrowserProfileSourceId;
    errorCategory?: ProfileImportErrorCategory;
    copiedBytes?: number;
    importedCookieCount?: number;
    skippedCookieCount?: number;
    completedAt?: string;
    restartRequired?: boolean;
}
export interface BrowserProfileImportStatus {
    active: boolean;
    restartRequired: boolean;
    sourceId?: string;
    completedAt?: string;
    copiedBytes?: number;
    importedCookieCount?: number;
    skippedCookieCount?: number;
    lastErrorCategory?: ProfileImportErrorCategory;
}
export declare function shouldExcludeProfileEntry(name: string): boolean;
/** 结构校验：快照至少要包含 Preferences / Cookies / Local Storage 之一才算有效 Profile 存储。 */
export declare function validateStagedProfileEntries(entries: ReadonlyArray<{
    name: string;
    isDirectory: boolean;
}>): boolean;
export interface ImportSessionHandle {
    setCookie: (details: ElectronCookieDetails) => Promise<void>;
    flushStore: () => Promise<void>;
}
export interface ProfileImporterDeps {
    destRoot: string;
    stateStore: ProfileImportStateStore;
    isProcessRunning: (processName: string) => Promise<boolean>;
    getSourceProfilePath?: (sourceId: BrowserProfileSourceId) => string | null;
    profileExists?: (profilePath: string) => boolean;
    readKeychainSecret?: typeof readKeychainSecret;
    readCookieRows?: (dbPath: string) => Promise<ChromiumCookieRow[]>;
    createSession?: (profilePath: string) => ImportSessionHandle;
    getAvailableBytes?: (path: string) => Promise<number | null>;
    nowIso?: () => string;
    onProgress?: (phase: ProfileImportPhase) => void;
}
export declare class BrowserProfileImporter {
    private readonly deps;
    private importInFlight;
    constructor(deps: ProfileImporterDeps);
    get currentProfilePath(): string;
    /** 渲染层状态视图：只含元数据与计数。 */
    getStatus(): BrowserProfileImportStatus;
    /** 上次导入后未重启 → 拒绝再次拷贝（进程内 session 缓存按绝对路径持有）。 */
    isRestartPending(): boolean;
    import(sourceId: string): Promise<BrowserProfileImportResult>;
    private runImport;
    private executeImport;
    /** 启动维护：清掉遗留 staging，校验 current；坏快照回滚 backup。返回可用 profilePath。 */
    prepareForStartup(): Promise<{
        profilePath: string | null;
        recovered: boolean;
    }>;
    private markLoaded;
    private validateDirectory;
}
//# sourceMappingURL=browser-profile-importer.d.ts.map
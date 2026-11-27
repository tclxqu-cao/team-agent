export declare const IMPORT_STATE_SCHEMA_VERSION = 1;
export type ProfileImportErrorCategory = "source-unavailable" | "source-browser-running" | "keychain-denied" | "unsupported-profile" | "insufficient-disk-space" | "copy-failed" | "cookie-migration-failed" | "validation-failed" | "restart-required" | "chrome-unavailable" | "chrome-login-canceled" | "chrome-login-timeout" | "login-callback-origin-mismatch" | "cookie-sync-failed";
export interface ProfileImportState {
    schemaVersion: number;
    sourceId: string;
    completedAt: string;
    destinationPath: string;
    copiedBytes: number;
    importedCookieCount: number;
    skippedCookieCount: number;
    restartRequired: boolean;
    lastErrorCategory?: ProfileImportErrorCategory;
}
/** 清洗任意输入为可用元数据；结构不合法返回 null（调用方按未导入处理）。 */
export declare function normalizeProfileImportState(raw: unknown): ProfileImportState | null;
export declare class ProfileImportStateStore {
    private readonly filePath;
    constructor(filePath: string);
    load(): ProfileImportState | null;
    save(state: ProfileImportState): void;
}
//# sourceMappingURL=import-state.d.ts.map
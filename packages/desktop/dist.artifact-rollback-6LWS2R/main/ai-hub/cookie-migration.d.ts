export interface ElectronCookieDetails {
    url: string;
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expirationDate?: number;
    sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}
export interface ChromiumCookieRow {
    host_key: string | null;
    name: string | null;
    value: string | null;
    encrypted_value: Uint8Array | null;
    path: string | null;
    expires_utc: number | null;
    is_secure: number | null;
    is_httponly: number | null;
    is_persistent: number | null;
    has_expires: number | null;
    samesite: number | null;
    top_frame_site_id?: string | null;
    partition_id?: number | null;
}
export interface SkipCounters {
    expired: number;
    malformed: number;
    partitioned: number;
    undecryptable: number;
}
export declare function deriveChromiumCookieKey(secret: string): Buffer;
export declare function decryptChromiumV10Value(encrypted: Buffer, secret: string): string | null;
export declare function chromeTimestampToUnixSeconds(micros: number): number;
export declare function mapChromiumSameSite(value: number | null): ElectronCookieDetails["sameSite"];
export type CookieRowOutcome = {
    status: "ok";
    details: ElectronCookieDetails;
} | {
    status: "skip";
    reason: keyof SkipCounters;
};
/** 单行迁移决策：过期/畸形/分区/不可解密都按类别跳过，绝不抛出值本身。 */
export declare function chromiumRowToCookieDetails(row: ChromiumCookieRow, secret: string, nowUnixSec: number): CookieRowOutcome;
export interface CookieMigrationSummary {
    details: ElectronCookieDetails[];
    imported: number;
    skipped: SkipCounters;
    total: number;
}
export interface CollectCookiesDeps {
    rows: ChromiumCookieRow[];
    keychainSecret: string;
    nowUnixSec?: number;
}
export declare function collectCookieDetails(deps: CollectCookiesDeps): CookieMigrationSummary;
/** 从 staging 快照只读打开 Cookies 库；仅在主进程（Electron 内置 node:sqlite）可用。 */
export declare function readChromiumCookieRows(dbPath: string): Promise<ChromiumCookieRow[]>;
export interface KeychainDeps {
    run?: (file: string, args: string[]) => Promise<string>;
}
/** 读取浏览器 Safe Storage 密钥；任何失败都归为 keychain-denied，不区分错误细节。 */
export declare function readKeychainSecret(service: string, deps?: KeychainDeps): Promise<string>;
export interface CdpCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: string;
    partitionKey?: unknown;
    partitionKeyOpaque?: boolean;
}
export declare function cdpCookieToElectronDetails(cookie: CdpCookie): ElectronCookieDetails;
/** 只保留属于目标站点域（含父域匹配）的 cookie；Google 域由调用方一并传入。 */
export declare function cookiesBelongingToHosts<T extends {
    domain: string;
}>(cookies: T[], hosts: string[]): T[];
//# sourceMappingURL=cookie-migration.d.ts.map
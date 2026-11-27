export type BrowserProfileSourceId = "chrome-default" | "ego-lite-default";
export interface BrowserProfileSource {
    id: BrowserProfileSourceId;
    browserName: string;
    profileName: "Default";
    profilePath: string;
    keychainService: "Chrome Safe Storage" | "ego safe storage";
    available: boolean;
    running: boolean;
    sizeBytes?: number;
    reason?: string;
}
/** 渲染端只拿到清洗后的元数据：绝不含 profilePath / keychainService。 */
export interface BrowserProfileSourceView {
    id: BrowserProfileSourceId;
    browserName: string;
    profileName: "Default";
    available: boolean;
    running: boolean;
    sizeBytes?: number;
    reason?: string;
}
interface SourceDefinition {
    id: BrowserProfileSourceId;
    browserName: string;
    appSupportDirName: string;
    keychainService: BrowserProfileSource["keychainService"];
    processNames: string[];
}
export declare function getProfileSourceDefinition(sourceId: string): SourceDefinition | null;
export declare function isBrowserProfileSourceId(value: unknown): value is BrowserProfileSourceId;
export interface ProfileSourceDeps {
    homeDir?: string;
    /** 注入进程探测（测试用）；生产实现按进程名精确匹配 pgrep -x。 */
    isProcessRunning?: (processName: string) => Promise<boolean>;
    profileExists?: (profilePath: string) => boolean;
    computeSizeBytes?: (profilePath: string) => Promise<number | undefined>;
}
export declare function defaultProfilePath(sourceId: BrowserProfileSourceId, homeDir?: string): string | null;
declare function pgrepExact(processName: string): Promise<boolean>;
export declare const isProcessNameRunning: typeof pgrepExact;
export declare function sumDirectoryBytes(root: string): Promise<number | undefined>;
export declare function toSourceView(source: BrowserProfileSource): BrowserProfileSourceView;
export declare function listBrowserProfileSources(deps?: ProfileSourceDeps): Promise<BrowserProfileSource[]>;
export {};
//# sourceMappingURL=browser-profile-source.d.ts.map
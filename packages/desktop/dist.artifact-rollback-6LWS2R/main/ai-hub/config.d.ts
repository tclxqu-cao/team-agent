export type HubAdapterId = "deepseek" | "chatgpt" | "gemini" | "grok" | "generic";
export interface HubSite {
    id: string;
    name: string;
    url: string;
    icon?: string;
    adapter?: HubAdapterId;
}
export interface HubConfig {
    version: 1;
    sites: HubSite[];
}
export declare const PRESET_SITES: HubSite[];
export declare function defaultHubConfig(): HubConfig;
export declare function newCustomSiteId(): string;
export declare function normalizeHubConfig(raw: unknown): HubConfig;
export declare class HubConfigStore {
    private readonly filePath;
    constructor(filePath: string);
    loadSync(): {
        config: HubConfig;
        resetFromCorruption: boolean;
    };
    saveSync(config: HubConfig): void;
}
//# sourceMappingURL=config.d.ts.map
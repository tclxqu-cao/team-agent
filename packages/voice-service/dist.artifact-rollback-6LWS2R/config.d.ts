export interface VoiceServiceConfig {
    provider: "local" | "azure";
    azure: {
        key: string;
        region: string;
        language: string;
    } | null;
    host: string;
    port: number;
    token: string | null;
    asrModelDir: string;
    kwsModelDir: string;
}
export declare function resolveVoiceServiceConfig(env: Record<string, string | undefined>, cwd: string): VoiceServiceConfig;
//# sourceMappingURL=config.d.ts.map
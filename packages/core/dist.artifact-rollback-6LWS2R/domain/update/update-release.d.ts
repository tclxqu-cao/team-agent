export declare const AGENTROAM_REGISTRY_BASE = "https://registry.npmjs.org/agentroam";
export declare const AGENTROAM_REGISTRY_LATEST_URL = "https://registry.npmjs.org/agentroam/latest";
export declare const AGENTROAM_REGISTRY_PREVIEW_URL = "https://registry.npmjs.org/agentroam/preview";
export declare const AGENTROAM_REPOSITORY_BASE = "https://github.com/tclxqu-cao/team-agent";
export declare const AGENTROAM_REPOSITORY_BRANCH = "main";
export declare const AGENTROAM_RAW_BASE = "https://github.com/tclxqu-cao/team-agent/raw/main";
export declare const AGENTROAM_CLI_INSTALL_BASE = "https://github.com/tclxqu-cao/team-agent/raw/main/packages/cli/install";
export declare const AGENTROAM_RELEASE_BASE = "https://github.com/tclxqu-cao/team-agent/releases/download";
export type UpdateChannel = "latest" | "preview";
export type UpdatePlatform = "darwin-arm64" | "windows-amd64";
export type UpdateClient = "cli" | "desktop";
export type UpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "unavailable" | "downloading" | "installing" | "reconnecting" | "complete" | "failed";
export interface UpdateAsset {
    fileName: string;
    sha256: string;
    size?: number;
    signed?: boolean;
}
export interface CliInstallManifest {
    schemaVersion: 1;
    installers: Record<UpdatePlatform, UpdateAsset>;
}
export declare const CLI_INSTALL_FILE_NAMES: Record<UpdatePlatform, string>;
export interface UpdateReleaseManifest {
    schemaVersion: 2;
    version: string;
    channel: UpdateChannel;
    publishedAt: string;
    installers: {
        cli: Record<UpdatePlatform, UpdateAsset>;
        desktop?: Partial<Record<UpdatePlatform, UpdateAsset & {
            signed: false;
        }>>;
    };
}
export interface UpdateStatus {
    phase: UpdatePhase;
    currentVersion: string;
    targetVersion?: string;
    checkedAt?: number;
    progress?: number;
    message?: string;
    asset?: UpdateAsset;
}
interface ParsedVersion {
    core: [bigint, bigint, bigint];
    preview: bigint | null;
}
export declare function parseAgentRoamVersion(value: string): ParsedVersion | null;
export declare function parseStableVersion(value: unknown): string | null;
export declare function resolveUpdateChannel(currentVersion: string): UpdateChannel;
export declare function resolveReleaseChannel(version: string): UpdateChannel;
export declare function registryUrlsForChannel(channel: UpdateChannel): string[];
export declare function parseChannelVersion(value: unknown, channel: UpdateChannel): string | null;
export declare function compareAgentRoamVersions(leftValue: string, rightValue: string): number;
export declare function expectedUpdateFileName(client: UpdateClient, platform: UpdatePlatform, version: string): string;
export declare function buildCliInstallManifestUrl(): string;
export declare function buildCliInstallScriptUrl(fileName: string): string;
export declare function validateCliInstallManifest(value: unknown, platform: UpdatePlatform): UpdateAsset;
export declare function buildDesktopManifestUrl(version: string): string;
export declare function buildDesktopAssetUrl(version: string, fileName: string): string;
export declare function validateReleaseManifest(value: unknown, candidateVersion: string, client: UpdateClient, platform: UpdatePlatform): {
    manifest: UpdateReleaseManifest;
    asset: UpdateAsset;
};
export {};
//# sourceMappingURL=update-release.d.ts.map
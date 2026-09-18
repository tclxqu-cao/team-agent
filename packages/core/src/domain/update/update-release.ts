export const AGENTROAM_REGISTRY_BASE = "https://registry.npmjs.org/agentroam";
export const AGENTROAM_REGISTRY_LATEST_URL = `${AGENTROAM_REGISTRY_BASE}/latest`;
export const AGENTROAM_REGISTRY_PREVIEW_URL = `${AGENTROAM_REGISTRY_BASE}/preview`;
// 唯一分发仓库。CLI 安装器是版本无关的脚本，直接走分支 raw 路径，不依赖发版产物；
// 桌面端安装包是构建产物，只能走 Releases 资产。
export const AGENTROAM_REPOSITORY_BASE = "https://github.com/tclxqu-cao/team-agent";
export const AGENTROAM_REPOSITORY_BRANCH = "main";
export const AGENTROAM_RAW_BASE = `${AGENTROAM_REPOSITORY_BASE}/raw/${AGENTROAM_REPOSITORY_BRANCH}`;
export const AGENTROAM_CLI_INSTALL_BASE = `${AGENTROAM_RAW_BASE}/packages/cli/install`;
export const AGENTROAM_RELEASE_BASE = `${AGENTROAM_REPOSITORY_BASE}/releases/download`;

export type UpdateChannel = "latest" | "preview";
export type UpdatePlatform = "darwin-arm64" | "windows-amd64";
export type UpdateClient = "cli" | "desktop";
export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "unavailable"
  | "downloading"
  | "installing"
  | "reconnecting"
  | "complete"
  | "failed";

export interface UpdateAsset {
  fileName: string;
  sha256: string;
  size?: number;
  signed?: boolean;
}

// CLI 安装器清单。刻意不含 version 字段：安装脚本与版本无关（运行时按 npm
// dist-tag 解析，或被 AGENTROAM_VERSION 钉住），因此一份清单对所有版本都成立。
export interface CliInstallManifest {
  schemaVersion: 1;
  installers: Record<UpdatePlatform, UpdateAsset>;
}

export const CLI_INSTALL_FILE_NAMES: Record<UpdatePlatform, string> = {
  "darwin-arm64": "install-agentroam.sh",
  "windows-amd64": "install-agentroam.ps1",
};

export interface UpdateReleaseManifest {
  schemaVersion: 2;
  version: string;
  channel: UpdateChannel;
  publishedAt: string;
  installers: {
    cli: Record<UpdatePlatform, UpdateAsset>;
    desktop?: Partial<Record<UpdatePlatform, UpdateAsset & { signed: false }>>;
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

export function parseAgentRoamVersion(value: string): ParsedVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) return null;
  return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], preview: match[4] === undefined ? null : BigInt(match[4]) };
}

export function parseStableVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = parseAgentRoamVersion(value);
  return parsed && parsed.preview === null ? value : null;
}

// A prerelease installation follows the preview channel; a stable installation
// follows latest. Preview users are also offered a newer stable release when
// npm latest overtakes the preview line, so they can migrate to the stable
// track without reinstalling.
export function resolveUpdateChannel(currentVersion: string): UpdateChannel {
  const parsed = parseAgentRoamVersion(currentVersion);
  if (!parsed) throw new Error("invalid AgentRoam version");
  return parsed.preview === null ? "latest" : "preview";
}

export function resolveReleaseChannel(version: string): UpdateChannel {
  const parsed = parseAgentRoamVersion(version);
  if (!parsed) throw new Error("invalid AgentRoam version");
  return parsed.preview === null ? "latest" : "preview";
}

export function registryUrlsForChannel(channel: UpdateChannel): string[] {
  return channel === "preview" ? [AGENTROAM_REGISTRY_LATEST_URL, AGENTROAM_REGISTRY_PREVIEW_URL] : [AGENTROAM_REGISTRY_LATEST_URL];
}

export function parseChannelVersion(value: unknown, channel: UpdateChannel): string | null {
  const stable = parseStableVersion(value);
  if (stable) return stable;
  if (channel !== "preview") return null;
  if (typeof value !== "string") return null;
  return parseAgentRoamVersion(value) ? value : null;
}

export function compareAgentRoamVersions(leftValue: string, rightValue: string): number {
  const left = parseAgentRoamVersion(leftValue);
  const right = parseAgentRoamVersion(rightValue);
  if (!left || !right) throw new Error("invalid AgentRoam version");
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (left.preview === right.preview) return 0;
  if (left.preview === null) return 1;
  if (right.preview === null) return -1;
  return left.preview > right.preview ? 1 : -1;
}

export function expectedUpdateFileName(client: UpdateClient, platform: UpdatePlatform, version: string): string {
  if (!parseAgentRoamVersion(version)) throw new Error("invalid update version");
  if (client === "cli") return CLI_INSTALL_FILE_NAMES[platform];
  return platform === "darwin-arm64"
    ? `AgentRoam-${version}-arm64.dmg`
    : `AgentRoam-Setup-${version}-x64.exe`;
}

// ---- CLI 安装器：分支 raw 路径（不依赖发版产物）-------------------------------

export function buildCliInstallManifestUrl(): string {
  return `${AGENTROAM_CLI_INSTALL_BASE}/install-manifest.json`;
}

export function buildCliInstallScriptUrl(fileName: string): string {
  if (!Object.values(CLI_INSTALL_FILE_NAMES).includes(fileName)) throw new Error("invalid CLI installer file name");
  return `${AGENTROAM_CLI_INSTALL_BASE}/${fileName}`;
}

export function validateCliInstallManifest(value: unknown, platform: UpdatePlatform): UpdateAsset {
  const expected = CLI_INSTALL_FILE_NAMES[platform];
  if (!expected) throw new Error("CLI install manifest does not support this platform");
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.installers)) throw new Error("invalid CLI install manifest identity");
  const asset = value.installers[platform];
  if (!isRecord(asset) || asset.fileName !== expected || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error("invalid CLI installer metadata");
  }
  if (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size <= 0)) throw new Error("invalid CLI installer size");
  return { fileName: expected, sha256: asset.sha256, ...(asset.size === undefined ? {} : { size: asset.size as number }) };
}

// ---- 桌面端安装包：Releases 资产（dmg / exe 是构建产物，进不了源码仓库）--------

export function buildDesktopManifestUrl(version: string): string {
  if (!parseAgentRoamVersion(version)) throw new Error("invalid update version");
  return `${AGENTROAM_RELEASE_BASE}/v${version}/release-manifest.json`;
}

export function buildDesktopAssetUrl(version: string, fileName: string): string {
  if (!parseAgentRoamVersion(version) || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("invalid update asset coordinates");
  }
  return `${AGENTROAM_RELEASE_BASE}/v${version}/${encodeURIComponent(fileName)}`;
}

export function validateReleaseManifest(
  value: unknown,
  candidateVersion: string,
  client: UpdateClient,
  platform: UpdatePlatform,
): { manifest: UpdateReleaseManifest; asset: UpdateAsset } {
  const expectedChannel = resolveReleaseChannel(candidateVersion);
  if (!isRecord(value) || value.schemaVersion !== 2 || value.channel !== expectedChannel || value.version !== candidateVersion) {
    throw new Error("invalid update manifest identity");
  }
  if (!parseAgentRoamVersion(candidateVersion) || typeof value.publishedAt !== "string" || !Number.isFinite(Date.parse(value.publishedAt))) {
    throw new Error("invalid update manifest release");
  }
  const installers = value.installers;
  if (!isRecord(installers) || !isRecord(installers[client]) || !isRecord(installers[client][platform])) {
    throw new Error("update manifest does not support this client platform");
  }
  const asset = installers[client][platform];
  const expected = expectedUpdateFileName(client, platform, candidateVersion);
  if (asset.fileName !== expected || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error("invalid update asset metadata");
  }
  if (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size <= 0)) throw new Error("invalid update asset size");
  if (client === "desktop" && asset.signed !== false) throw new Error("desktop signing metadata is invalid");
  return { manifest: value as unknown as UpdateReleaseManifest, asset: asset as unknown as UpdateAsset };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

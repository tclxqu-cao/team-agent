export const AGENTROAM_REGISTRY_LATEST_URL = "https://registry.npmjs.org/agentroam/latest";
export const AGENTROAM_GITEE_RELEASE_BASE = "https://gitee.com/caoqu/team-agent/releases/download";

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

export interface UpdateReleaseManifest {
  schemaVersion: 2;
  version: string;
  channel: "latest";
  publishedAt: string;
  installers: {
    cli: Record<UpdatePlatform, UpdateAsset>;
    desktop: Record<UpdatePlatform, UpdateAsset & { signed: false }>;
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
  if (!parseStableVersion(version)) throw new Error("update version must be stable");
  if (client === "cli") return platform === "darwin-arm64" ? "install-agentroam.sh" : "install-agentroam.ps1";
  return platform === "darwin-arm64"
    ? `AgentRoam-${version}-arm64.dmg`
    : `AgentRoam-Setup-${version}-x64.exe`;
}

export function buildGiteeManifestUrl(version: string): string {
  if (!parseStableVersion(version)) throw new Error("update version must be stable");
  return `${AGENTROAM_GITEE_RELEASE_BASE}/v${version}/release-manifest.json`;
}

export function buildGiteeAssetUrl(version: string, fileName: string): string {
  if (!parseStableVersion(version) || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("invalid update asset coordinates");
  }
  return `${AGENTROAM_GITEE_RELEASE_BASE}/v${version}/${encodeURIComponent(fileName)}`;
}

export function validateReleaseManifest(
  value: unknown,
  candidateVersion: string,
  client: UpdateClient,
  platform: UpdatePlatform,
): { manifest: UpdateReleaseManifest; asset: UpdateAsset } {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.channel !== "latest" || value.version !== candidateVersion) {
    throw new Error("invalid update manifest identity");
  }
  if (!parseStableVersion(candidateVersion) || typeof value.publishedAt !== "string" || !Number.isFinite(Date.parse(value.publishedAt))) {
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

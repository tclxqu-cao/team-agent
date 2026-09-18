// The published CLI package does not depend on @agent/core, so the CLI installer
// coordinates are duplicated here. Keep them in sync with
// packages/core/src/domain/update/update-release.ts ——
// packages/cli/src/update/update-install.test.ts asserts both sides agree.
//
// CLI 安装器是版本无关的脚本（运行时按 npm dist-tag 解析版本，或被
// AGENTROAM_VERSION 钉住），因此直接从仓库分支 raw 路径分发，不依赖发版产物。
export type CliPlatform = "darwin-arm64" | "windows-amd64";

const REPOSITORY_BASE = "https://github.com/tclxqu-cao/team-agent";
const REPOSITORY_BRANCH = "main";
const INSTALL_BASE = `${REPOSITORY_BASE}/raw/${REPOSITORY_BRANCH}/packages/cli/install`;

export const CLI_INSTALL_FILE_NAMES: Record<CliPlatform, string> = {
  "darwin-arm64": "install-agentroam.sh",
  "windows-amd64": "install-agentroam.ps1",
};

export interface CliInstallerAsset {
  fileName: string;
  sha256: string;
  size?: number;
}

export function buildCliInstallManifestUrl(): string {
  return `${INSTALL_BASE}/install-manifest.json`;
}

export function buildCliInstallScriptUrl(fileName: string): string {
  if (!Object.values(CLI_INSTALL_FILE_NAMES).includes(fileName)) throw new Error("invalid CLI installer file name");
  return `${INSTALL_BASE}/${fileName}`;
}

export function validateCliInstallManifest(value: unknown, platform: CliPlatform): CliInstallerAsset {
  const expected = CLI_INSTALL_FILE_NAMES[platform];
  if (!expected) throw new Error("CLI install manifest does not support this platform");
  if (typeof value !== "object" || value === null) throw new Error("invalid CLI install manifest identity");
  const manifest = value as { schemaVersion?: unknown; installers?: Record<string, unknown> | null };
  if (manifest.schemaVersion !== 1 || typeof manifest.installers !== "object" || manifest.installers === null) {
    throw new Error("invalid CLI install manifest identity");
  }
  const asset = manifest.installers[platform] as { fileName?: unknown; sha256?: unknown; size?: unknown } | undefined;
  if (!asset || asset.fileName !== expected || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error("invalid CLI installer metadata");
  }
  if (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || (asset.size as number) <= 0)) {
    throw new Error("invalid CLI installer size");
  }
  return { fileName: expected, sha256: asset.sha256, ...(asset.size === undefined ? {} : { size: asset.size as number }) };
}

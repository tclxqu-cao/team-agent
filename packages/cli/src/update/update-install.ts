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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { updatePaths, type DurableUpdateState } from "./update-state.js";


export function cliLauncherPath(dataDir: string, version: string): string {
  return resolve(dataDir, "launcher", version, "node_modules", "agentroam", "bin", "agentroam.mjs");
}

export async function installCliLauncher(
  state: Pick<DurableUpdateState, "dataDir" | "targetVersion" | "fileName" | "sha256" | "roots">,
  fetchImpl: typeof fetch = fetch,
  onInstalling?: () => Promise<void>,
): Promise<string> {
  const url = buildCliInstallScriptUrl(state.fileName);
  const temporary = await mkdtemp(resolve(updatePaths(state.dataDir).directory, "installer-"));
  try {
    const installer = resolve(temporary, state.fileName);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error("installer download failed");
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(installer, { flags: "wx", mode: 0o700 }));
    const actual = createHash("sha256").update(await readFile(installer)).digest("hex");
    if (actual !== state.sha256) throw new Error("installer checksum mismatch");
    await onInstalling?.();
    const command = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer] : [installer];
    const code = await new Promise<number | null>((done, reject) => {
      const child = spawn(command, args, { stdio: "ignore", windowsHide: true, env: {
        ...process.env,
        AGENTROAM_VERSION: state.targetVersion,
        AGENTROAM_DATA_DIR: state.dataDir,
        AGENTROAM_ROOT: state.roots[0],
        AGENTROAM_INSTALL_SKIP_SERVICE: "1",
        AGENTROAM_INSTALL_DESKTOP: "no",
        AGENTROAM_INSTALL_REMOTE_DESKTOP: "skip",
      } });
      child.once("error", reject);
      child.once("exit", done);
    });
    if (code !== 0) throw new Error(`installer exited with code ${code}`);
    const entry = cliLauncherPath(state.dataDir, state.targetVersion);
    await access(entry);
    return entry;
  } finally {
    await rm(temporary, { force: true, recursive: true }).catch(() => undefined);
  }
}

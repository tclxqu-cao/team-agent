import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PLATFORM_DEPENDENCY_VERSIONS } from "../platform-packages.js";
import type { PlatformTarget } from "../platform.js";
import { TAILSCALE_PACKAGES } from "./manifest.js";

export interface BundledTailscaleAsset {
  assetPath: string;
  sha256: string;
  size: number;
  /** 归档内必须存在的二进制文件名（含平台后缀），如 darwin 为 ["tailscale","tailscaled"]。 */
  entries: string[];
  version: string;
}

interface PackageManifest {
  packageVersion?: unknown;
  upstreamVersion?: unknown;
  target?: unknown;
  assetFormat?: unknown;
  entries?: unknown;
  size?: unknown;
  sha256?: unknown;
}

export async function resolveBundledTailscale(
  target: PlatformTarget,
  requireFromCli: NodeRequire = createRequire(import.meta.url),
): Promise<BundledTailscaleAsset | null> {
  const packageName = TAILSCALE_PACKAGES[target];
  if (!packageName) return null;

  let manifestPath: string;
  let assetPath: string;
  try {
    manifestPath = requireFromCli.resolve(`${packageName}/manifest.json`);
    assetPath = requireFromCli.resolve(`${packageName}/archive`);
  } catch (error) {
    if (["MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"].includes((error as NodeJS.ErrnoException)?.code ?? "")) return null;
    throw error;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
  const expectedEntries = target === "windows-amd64" ? ["tailscale.exe", "tailscaled.exe"] : ["tailscale", "tailscaled"];
  if (
    manifest.packageVersion !== PLATFORM_DEPENDENCY_VERSIONS[packageName] ||
    manifest.target !== target ||
    manifest.assetFormat !== "tgz" ||
    typeof manifest.upstreamVersion !== "string" ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== expectedEntries.length ||
    !expectedEntries.every(entry => (manifest.entries as unknown[]).includes(entry)) ||
    typeof manifest.size !== "number" ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size <= 0 ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error(`invalid tailscale platform manifest: ${manifestPath}`);
  }

  return {
    assetPath,
    sha256: manifest.sha256,
    size: manifest.size,
    entries: manifest.entries as string[],
    version: manifest.upstreamVersion,
  };
}

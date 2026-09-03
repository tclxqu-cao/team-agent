import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { PlatformTarget } from "../platform.js";
import { CLOUDFLARED_PACKAGES, CLOUDFLARED_PACKAGE_VERSION } from "./manifest.js";

export interface BundledCloudflaredAsset {
  assetPath: string;
  assetFormat: "tgz" | "executable";
  sha256: string;
  size: number;
  fileName: string;
  version: string;
}

interface PackageManifest {
  packageVersion?: unknown;
  upstreamVersion?: unknown;
  target?: unknown;
  assetFormat?: unknown;
  fileName?: unknown;
  size?: unknown;
  sha256?: unknown;
}

export async function resolveBundledCloudflared(
  target: PlatformTarget,
  requireFromCli: NodeRequire = createRequire(import.meta.url),
): Promise<BundledCloudflaredAsset | null> {
  const packageName = CLOUDFLARED_PACKAGES[target];
  if (!packageName) return null;

  let manifestPath: string;
  let assetPath: string;
  try {
    manifestPath = requireFromCli.resolve(`${packageName}/manifest.json`);
    assetPath = requireFromCli.resolve(`${packageName}/archive`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
  if (
    manifest.packageVersion !== CLOUDFLARED_PACKAGE_VERSION ||
    manifest.target !== target ||
    (manifest.assetFormat !== "tgz" && manifest.assetFormat !== "executable") ||
    typeof manifest.upstreamVersion !== "string" ||
    typeof manifest.fileName !== "string" ||
    typeof manifest.size !== "number" ||
    !Number.isSafeInteger(manifest.size) ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error(`invalid cloudflared platform manifest: ${manifestPath}`);
  }

  return {
    assetPath,
    assetFormat: manifest.assetFormat,
    sha256: manifest.sha256,
    size: manifest.size,
    fileName: manifest.fileName,
    version: manifest.upstreamVersion,
  };
}

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { PlatformTarget } from "./platform.js";
import { MINIMUM_NODE_VERSION, assertSupportedNodeVersion } from "../bin/runtime-policy.mjs";

export const AGENTROAM_VERSION = "0.2.0-preview.18";

export interface RuntimePackageManifest {
  packageVersion: string;
  target: PlatformTarget;
  schemaVersion: 2;
  minimumNodeVersion: string;
  nativeFiles: Record<string, string>;
}

export interface PlatformPackageSet {
  runtime: string;
  cloudflared: string;
  tui: string;
}

export const PLATFORM_PACKAGES: Partial<Record<PlatformTarget, PlatformPackageSet>> = {
  "darwin-arm64": {
    runtime: "agentroam-runtime-darwin-arm64",
    cloudflared: "agentroam-cloudflared-darwin-arm64",
    tui: "agentroam-tui-darwin-arm64",
  },
  "windows-amd64": {
    runtime: "agentroam-runtime-win32-x64",
    cloudflared: "agentroam-cloudflared-win32-x64",
    tui: "@caoqu/agentroam-tui-win32-x64",
  },
};

export interface ResolvedRuntimePackage {
  packageName: string;
  runtimeRoot: string;
  manifestPath: string;
  manifest: RuntimePackageManifest;
}

export function requirePlatformPackages(target: PlatformTarget): PlatformPackageSet {
  const packages = PLATFORM_PACKAGES[target];
  if (!packages) throw new Error(`AgentRoam packages are unavailable for ${target}`);
  return packages;
}

export function resolvePlatformRuntime(
  target: PlatformTarget,
  requireFromCli: NodeRequire = createRequire(import.meta.url),
): ResolvedRuntimePackage {
  const packageName = requirePlatformPackages(target).runtime;
  let manifestPath: string;
  let runtimePackageJson: string;
  try {
    manifestPath = requireFromCli.resolve(`${packageName}/manifest.json`);
    runtimePackageJson = requireFromCli.resolve(`${packageName}/runtime`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "MODULE_NOT_FOUND") {
      throw new Error(`AgentRoam runtime package missing for ${target}; reinstall agentroam@${AGENTROAM_VERSION}`);
    }
    throw error;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<RuntimePackageManifest>;
  if (
    manifest.packageVersion !== AGENTROAM_VERSION
    || manifest.target !== target
    || manifest.schemaVersion !== 2
    || manifest.minimumNodeVersion !== MINIMUM_NODE_VERSION
    || !manifest.nativeFiles
    || typeof manifest.nativeFiles !== "object"
    || Array.isArray(manifest.nativeFiles)
  ) {
    throw new Error(`invalid AgentRoam runtime manifest: ${manifestPath}`);
  }
  assertSupportedNodeVersion();

  return {
    packageName,
    runtimeRoot: dirname(runtimePackageJson),
    manifestPath,
    manifest: manifest as RuntimePackageManifest,
  };
}

export function resolvePlatformTui(
  target: PlatformTarget,
  requireFromCli: NodeRequire = createRequire(import.meta.url),
): string {
  const packageName = requirePlatformPackages(target).tui;
  try {
    return requireFromCli.resolve(`${packageName}/entry`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "MODULE_NOT_FOUND") {
      throw new Error(`AgentRoam TUI package missing for ${target}; reinstall agentroam@${AGENTROAM_VERSION}`);
    }
    throw error;
  }
}

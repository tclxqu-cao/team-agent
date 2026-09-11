import { assertSupportedNodeVersion } from "../bin/runtime-policy.mjs";

export type PlatformTarget = "darwin-arm64" | "darwin-amd64" | "windows-amd64";

export function detectPlatformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformTarget {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-amd64";
  if (platform === "win32" && arch === "x64") return "windows-amd64";
  throw Object.assign(new Error(`unsupported platform: ${platform}-${arch}`), { exitCode: 2 });
}

export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  nodeVersion: string = process.versions.node,
): PlatformTarget {
  assertSupportedNodeVersion(nodeVersion);
  return detectPlatformTarget(platform, arch);
}

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
  const major = Number(nodeVersion.split(".")[0]);
  if (major !== 22) {
    throw Object.assign(new Error(`Node.js 22 required (current ${nodeVersion})`), { exitCode: 2 });
  }
  return detectPlatformTarget(platform, arch);
}

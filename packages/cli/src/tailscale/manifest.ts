import type { PlatformTarget } from "../platform.js";
import { PLATFORM_DEPENDENCY_VERSIONS, requirePlatformPackages } from "../platform-packages.js";

/**
 * tailscale 平台包（agentroam-tailscale-<target>）由
 * scripts/build-tailscale-platform-package.mjs 在打包期从 tailscale 源码
 * （pinned tag）构建：官方只为 Linux 发布裸 tgz，macOS/Windows 无官方裸二进制分发，
 * 因此归档在打包期生成，运行期缺平台包时回落 PATH 探测（Homebrew / 官方安装）。
 */
export const TAILSCALE_PACKAGES: Partial<Record<PlatformTarget, string>> = {
  "darwin-arm64": requirePlatformPackages("darwin-arm64").tailscale,
  "windows-amd64": requirePlatformPackages("windows-amd64").tailscale,
};

export function tailscalePackageVersion(target: PlatformTarget): string | undefined {
  const packageName = TAILSCALE_PACKAGES[target];
  return packageName ? PLATFORM_DEPENDENCY_VERSIONS[packageName] : undefined;
}

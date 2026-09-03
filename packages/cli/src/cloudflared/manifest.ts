import type { PlatformTarget } from "../platform.js";
import { AGENTROAM_VERSION, requirePlatformPackages } from "../platform-packages.js";

export const CLOUDFLARED_VERSION = "2026.8.2";
export const CLOUDFLARED_PACKAGE_VERSION = AGENTROAM_VERSION;

export const CLOUDFLARED_PACKAGES: Partial<Record<PlatformTarget, string>> = {
  "darwin-arm64": requirePlatformPackages("darwin-arm64").cloudflared,
  "windows-amd64": requirePlatformPackages("windows-amd64").cloudflared,
};

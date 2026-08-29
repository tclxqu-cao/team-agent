import type { PlatformTarget } from "../platform.js";

export const CLOUDFLARED_VERSION = "2026.8.2";
export const CLOUDFLARED_PACKAGE_VERSION = "0.2.0-preview.4";

export const CLOUDFLARED_PACKAGES: Partial<Record<PlatformTarget, string>> = {
  "darwin-arm64": "agentroam-cloudflared-darwin-arm64",
};

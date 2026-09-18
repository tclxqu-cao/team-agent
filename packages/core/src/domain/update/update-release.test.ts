import { describe, expect, it } from "vitest";
import {
  buildCliInstallManifestUrl,
  buildCliInstallScriptUrl,
  buildDesktopAssetUrl,
  buildDesktopManifestUrl,
  compareAgentRoamVersions,
  parseChannelVersion,
  parseStableVersion,
  resolveReleaseChannel,
  resolveUpdateChannel,
  validateCliInstallManifest,
  validateReleaseManifest,
} from "./update-release.js";

const sha256 = "a".repeat(64);
function manifest(version = "1.2.3") {
  return {
    schemaVersion: 2,
    version,
    channel: "latest",
    publishedAt: "2026-09-08T00:00:00.000Z",
    installers: {
      cli: {
        "darwin-arm64": { fileName: "install-agentroam.sh", sha256 },
        "windows-amd64": { fileName: "install-agentroam.ps1", sha256 },
      },
      desktop: {
        "darwin-arm64": { fileName: `AgentRoam-${version}-arm64.dmg`, sha256, signed: false },
        "windows-amd64": { fileName: `AgentRoam-Setup-${version}-x64.exe`, sha256, signed: false },
      },
    },
  };
}

describe("update release", () => {
  it("accepts stable versions and rejects prereleases", () => {
    expect(parseStableVersion("1.2.3")).toBe("1.2.3");
    expect(parseStableVersion("1.2.3-preview.1")).toBeNull();
    expect(parseStableVersion("01.2.3")).toBeNull();
  });

  it("compares stable and preview versions", () => {
    expect(compareAgentRoamVersions("1.0.0", "1.0.0-preview.9")).toBe(1);
    expect(compareAgentRoamVersions("1.2.0", "1.1.9")).toBe(1);
  });

  it("validates the exact platform asset", () => {
    expect(validateReleaseManifest(manifest(), "1.2.3", "desktop", "windows-amd64").asset.fileName)
      .toBe("AgentRoam-Setup-1.2.3-x64.exe");
    expect(() => validateReleaseManifest({ ...manifest(), channel: "preview" }, "1.2.3", "desktop", "windows-amd64")).toThrow();
  });

  it("constructs only allowlisted release URLs", () => {
    expect(buildDesktopAssetUrl("1.2.3", "AgentRoam-1.2.3-arm64.dmg")).toContain("/v1.2.3/AgentRoam-1.2.3-arm64.dmg");
    expect(() => buildDesktopAssetUrl("1.2.3", "../payload")).toThrow();
  });

  it("distributes the CLI installer from the branch raw path, not a release asset", () => {
    expect(buildCliInstallManifestUrl()).toBe(
      "https://github.com/tclxqu-cao/team-agent/raw/main/packages/cli/install/install-manifest.json",
    );
    expect(buildCliInstallScriptUrl("install-agentroam.sh")).toBe(
      "https://github.com/tclxqu-cao/team-agent/raw/main/packages/cli/install/install-agentroam.sh",
    );
    // 只放行白名单文件名，避免被拿去拼任意路径。
    expect(() => buildCliInstallScriptUrl("../payload")).toThrow();
    expect(() => buildCliInstallScriptUrl("AgentRoam-1.2.3-arm64.dmg")).toThrow();
  });

  it("validates the CLI install manifest per platform", () => {
    const manifest = {
      schemaVersion: 1,
      installers: {
        "darwin-arm64": { fileName: "install-agentroam.sh", sha256, size: 11_625 },
        "windows-amd64": { fileName: "install-agentroam.ps1", sha256, size: 13_155 },
      },
    };
    expect(validateCliInstallManifest(manifest, "windows-amd64")).toEqual({ fileName: "install-agentroam.ps1", sha256, size: 13_155 });
    expect(() => validateCliInstallManifest({ ...manifest, schemaVersion: 2 }, "darwin-arm64")).toThrow();
    expect(() => validateCliInstallManifest(manifest, "linux-x64" as never)).toThrow();
    expect(() => validateCliInstallManifest({ schemaVersion: 1, installers: { "darwin-arm64": { fileName: "wrong.sh", sha256 } } }, "darwin-arm64")).toThrow();
    expect(() => validateCliInstallManifest({ schemaVersion: 1, installers: { "darwin-arm64": { fileName: "install-agentroam.sh", sha256: "short" } } }, "darwin-arm64")).toThrow();
  });

  it("routes prerelease installs to preview and stable to latest", () => {
    expect(resolveUpdateChannel("1.2.3")).toBe("latest");
    expect(resolveUpdateChannel("1.2.3-preview.4")).toBe("preview");
    expect(resolveReleaseChannel("1.2.3")).toBe("latest");
    expect(resolveReleaseChannel("1.2.3-preview.4")).toBe("preview");
  });

  it("parses channel candidates with preview-to-stable migration", () => {
    expect(parseChannelVersion("1.2.3", "latest")).toBe("1.2.3");
    expect(parseChannelVersion("1.2.3-preview.4", "latest")).toBeNull();
    expect(parseChannelVersion("1.2.3-preview.4", "preview")).toBe("1.2.3-preview.4");
    expect(parseChannelVersion("1.2.3", "preview")).toBe("1.2.3");
    expect(parseChannelVersion("not-a-version", "preview")).toBeNull();
  });

  it("validates a preview manifest for a preview candidate", () => {
    const previewManifest = manifest("1.2.3-preview.4");
    previewManifest.channel = "preview";
    expect(validateReleaseManifest(previewManifest, "1.2.3-preview.4", "cli", "darwin-arm64").asset.fileName)
      .toBe("install-agentroam.sh");
  });

  it("builds preview manifest URLs", () => {
    expect(buildDesktopManifestUrl("1.2.3-preview.4")).toContain("/v1.2.3-preview.4/release-manifest.json");
  });
});

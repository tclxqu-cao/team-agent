import { describe, expect, it } from "vitest";
import {
  buildGiteeAssetUrl,
  buildGiteeManifestUrl,
  compareAgentRoamVersions,
  parseChannelVersion,
  parseStableVersion,
  resolveReleaseChannel,
  resolveUpdateChannel,
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
    expect(buildGiteeAssetUrl("1.2.3", "install-agentroam.sh")).toContain("/v1.2.3/install-agentroam.sh");
    expect(() => buildGiteeAssetUrl("1.2.3", "../payload")).toThrow();
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
    expect(buildGiteeManifestUrl("1.2.3-preview.4")).toContain("/v1.2.3-preview.4/release-manifest.json");
  });
});

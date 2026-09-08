import { describe, expect, it } from "vitest";
import { buildGiteeAssetUrl, compareAgentRoamVersions, parseStableVersion, validateReleaseManifest } from "./update-release.js";

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
});

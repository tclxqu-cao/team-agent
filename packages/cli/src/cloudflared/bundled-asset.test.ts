import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledCloudflared } from "./bundled-asset.js";

describe("resolveBundledCloudflared", () => {
  it("resolves a valid platform package manifest and archive", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-bundled-resolver-"));
    const manifestPath = resolve(root, "manifest.json");
    const archivePath = resolve(root, "cloudflared.tgz");
    await writeFile(archivePath, "archive");
    await writeFile(manifestPath, JSON.stringify({
      packageVersion: "0.2.0-preview.4",
      upstreamVersion: "2026.8.2",
      target: "darwin-arm64",
      fileName: "cloudflared",
      size: 7,
      sha256: "a".repeat(64),
    }));

    const asset = await resolveBundledCloudflared("darwin-arm64", fakeRequire(manifestPath, archivePath));
    expect(asset).toEqual({
      archivePath,
      version: "2026.8.2",
      fileName: "cloudflared",
      size: 7,
      sha256: "a".repeat(64),
    });
  });

  it("rejects a mismatched platform package version", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-bundled-version-"));
    const manifestPath = resolve(root, "manifest.json");
    const archivePath = resolve(root, "cloudflared.tgz");
    await writeFile(archivePath, "archive");
    await writeFile(manifestPath, JSON.stringify({
      packageVersion: "0.2.0-preview.2",
      upstreamVersion: "2026.8.2",
      target: "darwin-arm64",
      fileName: "cloudflared",
      size: 7,
      sha256: "a".repeat(64),
    }));

    await expect(resolveBundledCloudflared("darwin-arm64", fakeRequire(manifestPath, archivePath)))
      .rejects.toThrow("invalid cloudflared platform manifest");
  });
});

function fakeRequire(manifestPath: string, archivePath: string): NodeRequire {
  return {
    resolve: (id: string) => id.endsWith("/manifest.json") ? manifestPath : archivePath,
  } as NodeRequire;
}

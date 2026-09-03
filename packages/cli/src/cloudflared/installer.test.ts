import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BundledCloudflaredAsset } from "./bundled-asset.js";
import { ensureCloudflared, findSystemCloudflared } from "./installer.js";

describe("ensureCloudflared", () => {
  it("extracts a verified bundled archive and repairs executable permissions", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-cloudflared-bundle-"));
    const asset = await createArchive(root, "#!/bin/sh\necho bundled\n");

    const executable = await ensureCloudflared("darwin-arm64", resolve(root, "data"), {
      resolveBundled: async () => asset,
      findSystem: async () => null,
    });

    expect(await readFile(executable, "utf8")).toContain("bundled");
    await access(executable, constants.X_OK);
    expect(await readFile(`${executable}.source.sha256`, "utf8")).toBe(`${asset.sha256}\n`);
  });

  it("reuses the verified cache", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-cloudflared-cache-"));
    const asset = await createArchive(root, "#!/bin/sh\n");
    const resolver = vi.fn(async () => asset);
    const options = { resolveBundled: resolver, findSystem: async () => null };
    const first = await ensureCloudflared("darwin-arm64", resolve(root, "data"), options);
    const second = await ensureCloudflared("darwin-arm64", resolve(root, "data"), options);
    expect(second).toBe(first);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("copies a verified Windows executable without tar", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-cloudflared-windows-"));
    const assetPath = resolve(root, "source.exe");
    const bytes = Buffer.from("MZ-test-windows-binary");
    await writeFile(assetPath, bytes);
    const asset: BundledCloudflaredAsset = {
      assetPath,
      assetFormat: "executable",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      fileName: "cloudflared.exe",
      version: "test",
    };

    const executable = await ensureCloudflared("windows-amd64", resolve(root, "data"), {
      resolveBundled: async () => asset,
      findSystem: async () => null,
    });

    expect(executable).toBe(resolve(root, "data/bin/cloudflared.exe"));
    expect(await readFile(executable)).toEqual(bytes);
  });

  it("falls back to PATH when the bundled checksum is invalid", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-cloudflared-fallback-"));
    const asset = await createArchive(root, "#!/bin/sh\n");
    const system = resolve(root, "system-cloudflared");
    await writeFile(system, "#!/bin/sh\n", { mode: 0o755 });
    const result = await ensureCloudflared("darwin-arm64", resolve(root, "data"), {
      resolveBundled: async () => ({ ...asset, sha256: "0".repeat(64) }),
      findSystem: async () => system,
    });
    expect(result).toBe(system);
  });

  it("reports package and PATH failures without downloading", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-cloudflared-missing-"));
    await expect(
      ensureCloudflared("darwin-arm64", resolve(root, "data"), {
        resolveBundled: async () => null,
        findSystem: async () => null,
      }),
    ).rejects.toThrow("platform package missing for darwin-arm64; no executable on PATH");
  });
});

describe("findSystemCloudflared", () => {
  it("reuses an executable cloudflared already installed on PATH", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agentroam-cloudflared-path-"));
    const executable = resolve(directory, "cloudflared");
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o644 });
    expect(await findSystemCloudflared(directory, "darwin")).toBeNull();
    await chmod(executable, 0o755);
    expect(await findSystemCloudflared(directory, "darwin")).toBe(executable);
  });
});

async function createArchive(root: string, content: string): Promise<BundledCloudflaredAsset> {
  const source = resolve(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, "cloudflared"), content, { mode: 0o644 });
  const archivePath = resolve(root, "cloudflared.tgz");
  execFileSync("tar", ["-czf", archivePath, "-C", source, "cloudflared"]);
  const bytes = await readFile(archivePath);
  return {
    assetPath: archivePath,
    assetFormat: "tgz",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: (await stat(archivePath)).size,
    fileName: "cloudflared",
    version: "test",
  };
}

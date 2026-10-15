import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundledRuntimePackages } from "./bundled-runtime.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
for (const [target, platform] of [["darwin-arm64", "darwin-arm64"], ["windows-amd64", "win32-x64"]]) {
  it(`checks the complete ${target} bundle before installing and rejects tampering`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentroam-runtime-bundle-")); directories.push(directory);
    const packages = [];
    for (const name of ["agentroam", `agentroam-runtime-${platform}`]) {
      const content = Buffer.from(name);
      const file = `${name}-test.tgz`;
      await writeFile(join(directory, file), content);
      packages.push({ name, file, version: "test.1", sha256: createHash("sha256").update(content).digest("hex") });
    }
    const manifest = { schemaVersion: 1, target, launcherVersion: "test.1", packages };
    const save = value => writeFile(join(directory, "manifest.json"), JSON.stringify(value));
    await save(manifest);
    expect(await bundledRuntimePackages(directory, target, "test.1", "test.1")).toEqual(packages.map(p => join(directory, p.file)));
    await expect(bundledRuntimePackages(directory, target, "test.2", "test.1")).rejects.toThrow("Invalid desktop runtime bundle");
    await expect(bundledRuntimePackages(directory, target, "test.1", "test.2")).rejects.toThrow("Invalid desktop runtime package");
    await save({ ...manifest, target: "wrong" });
    await expect(bundledRuntimePackages(directory, target, "test.1", "test.1")).rejects.toThrow();
    await save({ ...manifest, packages: [packages[0], packages[0]] });
    await expect(bundledRuntimePackages(directory, target, "test.1", "test.1")).rejects.toThrow();
    await save({ ...manifest, packages: [{ ...packages[0], file: "../outside.tgz" }, packages[1]] });
    await expect(bundledRuntimePackages(directory, target, "test.1", "test.1")).rejects.toThrow();
    await save(manifest);
    await writeFile(join(directory, packages[0].file), "tampered");
    await expect(bundledRuntimePackages(directory, target, "test.1", "test.1")).rejects.toThrow("integrity check failed");
    await rm(join(directory, packages[0].file));
    await expect(bundledRuntimePackages(directory, target, "test.1", "test.1")).rejects.toThrow();
  });
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Fail closed before npm executes anything from a packaged runtime bundle. */
export async function bundledRuntimePackages(directory, target, launcherVersion, runtimeVersion) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const platform = target === "darwin-arm64" ? "darwin-arm64" : target === "windows-amd64" ? "win32-x64" : null;
  if (!platform || manifest.schemaVersion !== 1 || manifest.target !== target || manifest.launcherVersion !== launcherVersion) {
    throw new Error("Invalid desktop runtime bundle");
  }
  const expected = new Map([
    ["agentroam", launcherVersion],
    [`agentroam-runtime-${platform}`, runtimeVersion],
  ]);
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== expected.size) throw new Error("Incomplete desktop runtime bundle");
  const files = [];
  for (const entry of manifest.packages) {
    if (!expected.has(entry.name) || entry.version !== expected.get(entry.name) || !/^[a-z0-9][a-z0-9._-]*\.tgz$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error("Invalid desktop runtime package");
    }
    expected.delete(entry.name);
    const file = join(directory, entry.file);
    const actual = createHash("sha256").update(await readFile(file)).digest("hex");
    if (actual !== entry.sha256) throw new Error("Desktop runtime bundle integrity check failed");
    files.push(file);
  }
  return files;
}

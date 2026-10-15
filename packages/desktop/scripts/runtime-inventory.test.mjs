import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_TARGETS } from "../../../scripts/runtime-native-files.mjs";
import { verifyDesktopRuntime } from "./runtime-inventory.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe("desktop downloaded runtime inventory", () => {
  for (const target of Object.keys(RUNTIME_TARGETS)) {
    it(`validates ${target} and rejects corrupt or missing native binaries`, async () => {
      const installation = await mkdtemp(join(tmpdir(), "agentroam-desktop-inventory-"));
      directories.push(installation);
      const packageName = target === "darwin-arm64" ? "agentroam-runtime-darwin-arm64" : "agentroam-runtime-win32-x64";
      const root = join(installation, "node_modules", packageName);
      const content = Buffer.from("runtime fixture");
      const nativeFiles = {};
      for (const file of RUNTIME_TARGETS[target].nativeFiles) {
        const path = join(root, "runtime", file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        nativeFiles[file] = createHash("sha256").update(content).digest("hex");
      }
      const manifest = { schemaVersion: 2, target, packageVersion: "test.1", capabilities: { nativeConsole: 1 }, nativeFiles };
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      await verifyDesktopRuntime(installation, target, "test.1");
      await expect(verifyDesktopRuntime(installation, target, "test.2")).rejects.toThrow("version mismatch");
      await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, capabilities: {} }));
      await expect(verifyDesktopRuntime(installation, target, "test.1")).rejects.toThrow("native console");
      await expect(verifyDesktopRuntime(installation, target, "test.1")).rejects.toMatchObject({ code: "RUNTIME_INCOMPATIBLE" });
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      const path = join(root, "runtime", RUNTIME_TARGETS[target].nativeFiles[0]);
      await writeFile(path, "corrupted");
      await expect(verifyDesktopRuntime(installation, target, "test.1")).rejects.toThrow("integrity check failed");
      await rm(path);
      await expect(verifyDesktopRuntime(installation, target, "test.1")).rejects.toThrow();
    });
  }
});

import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repairNativeRuntimePermissions } from "./native-runtime.js";

describe("repairNativeRuntimePermissions", () => {
  it("restores the node-pty helper execute bits stripped by npm pack", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-native-"));
    const helper = resolve(root, "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
    await mkdir(resolve(helper, ".."), { recursive: true });
    await writeFile(helper, "helper", { mode: 0o644 });

    await repairNativeRuntimePermissions(root, "darwin", "arm64");

    expect((await stat(helper)).mode & 0o111).toBe(0o111);
  });

  it("fails before gateway startup when the helper is missing", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentroam-native-missing-"));
    await expect(repairNativeRuntimePermissions(root, "darwin", "arm64")).rejects.toThrow("spawn-helper missing");
  });
});

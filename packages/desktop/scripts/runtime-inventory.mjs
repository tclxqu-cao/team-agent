import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_TARGETS, validateNativeInventory } from "../../../scripts/runtime-native-files.mjs";

/** Check the actual target binaries before a fresh desktop install starts a service. */
export async function verifyDesktopRuntime(installation, target, expectedVersion) {
  const config = RUNTIME_TARGETS[target];
  if (!config) throw new Error("Unsupported runtime target");
  const packageName = target === "darwin-arm64" ? "agentroam-runtime-darwin-arm64" : "agentroam-runtime-win32-x64";
  const root = join(installation, "node_modules", packageName);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.packageVersion !== expectedVersion || manifest.target !== target || manifest.schemaVersion !== 2) throw Object.assign(new Error("Runtime version mismatch"), { code: "RUNTIME_INCOMPATIBLE" });
  if (manifest.capabilities?.nativeConsole !== 1) throw Object.assign(new Error("Runtime does not support the native console"), { code: "RUNTIME_INCOMPATIBLE" });
  validateNativeInventory(manifest, config.nativeFiles.map(file => `package/runtime/${file}`));
  for (const file of config.nativeFiles) {
    const content = await readFile(join(root, "runtime", file));
    if (createHash("sha256").update(content).digest("hex") !== manifest.nativeFiles[file]) throw new Error(`Runtime integrity check failed: ${file}`);
  }
}

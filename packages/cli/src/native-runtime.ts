import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

export async function repairNativeRuntimePermissions(
  runtimeRoot: string,
  platform = process.platform,
  arch = process.arch,
): Promise<void> {
  if (platform === "win32") return;
  const helper = resolve(runtimeRoot, "node_modules/node-pty/prebuilds", `${platform}-${arch}`, "spawn-helper");
  try {
    await chmod(helper, 0o755);
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new Error(`node-pty spawn-helper missing: ${helper}`);
    throw new Error(`node-pty spawn-helper permission repair failed: ${error?.message ?? error}`);
  }
}

import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ServiceConfig } from "./service-files.js";

function versionParts(version: string): number[] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])] : null;
}
function older(candidate: string, current: string): boolean {
  const left = versionParts(candidate), right = versionParts(current);
  if (!left || !right) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] < right[i];
  return false;
}
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

/** Remove only recognized managed launcher versions after the replacement service is ready. */
export async function cleanupOldLaunchers(config: ServiceConfig, log: (line: string) => void): Promise<void> {
  try {
    const dataDir = await realpath(config.dataDir);
    const launcherDir = resolve(dataDir, "launcher");
    if (!(await lstat(launcherDir)).isDirectory() || (await lstat(launcherDir)).isSymbolicLink()) return;
    const currentDir = resolve(launcherDir, config.version);
    const expectedEntry = resolve(currentDir, "node_modules/agentroam/bin/agentroam.mjs");
    if (await realpath(config.cliPath) !== expectedEntry) return;
    const roots = await Promise.all(config.roots.map(async root => realpath(root).catch(() => resolve(root))));
    for (const entry of await readdir(launcherDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !older(entry.name, config.version)) continue;
      const candidate = resolve(launcherDir, entry.name);
      try {
        if (await lstat(`${candidate}.lock`).then(() => true, () => false)) continue;
        if (roots.some(root => contains(candidate, root))) continue;
        const files = await readdir(candidate);
        if (files.some(file => !["node_modules", "package.json", "package-lock.json"].includes(file))) continue;
        const manifestPath = resolve(candidate, "node_modules/agentroam/package.json");
        if (await realpath(manifestPath) !== manifestPath) continue;
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (manifest.name !== "agentroam" || manifest.version !== entry.name) continue;
        await rm(candidate, { recursive: true });
        log(`✓ 已清理旧版 CLI ${entry.name}，配置和数据已保留`);
      } catch { log(`旧版 CLI ${entry.name} 暂未清理，将在下次安装时重试。`); }
    }
  } catch { log("旧版 CLI 清理已跳过，新版服务不受影响。"); }
}

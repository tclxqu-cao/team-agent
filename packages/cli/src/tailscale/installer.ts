import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import type { PlatformTarget } from "../platform.js";
import { resolveBundledTailscale, type BundledTailscaleAsset } from "./bundled-asset.js";
import { sha256File } from "../cloudflared/checksum.js";

export interface TailscaleBinaries { tailscale: string; tailscaled: string }

interface EnsureTailscaleOptions {
  resolveBundled?: (target: PlatformTarget) => Promise<BundledTailscaleAsset | null>;
  findSystem?: (target: PlatformTarget) => Promise<TailscaleBinaries | null>;
}

/** 归档内固定两个二进制（tailscale CLI + tailscaled 守护进程），安装到 <dataDir>/bin。 */
export async function ensureTailscaleBinaries(
  target: PlatformTarget,
  dataDir: string,
  options: EnsureTailscaleOptions = {},
): Promise<TailscaleBinaries> {
  const executableSuffix = target === "windows-amd64" ? ".exe" : "";
  const binDir = resolve(dataDir, "bin");
  const finalPaths: TailscaleBinaries = {
    tailscale: resolve(binDir, `tailscale${executableSuffix}`),
    tailscaled: resolve(binDir, `tailscaled${executableSuffix}`),
  };
  await mkdir(binDir, { recursive: true });

  const resolveBundled = options.resolveBundled ?? resolveBundledTailscale;
  const findSystem = options.findSystem ?? findSystemTailscale;
  const failures: string[] = [];

  try {
    const bundled = await resolveBundled(target);
    if (bundled) {
      if (await cachedPair(finalPaths, bundled.sha256)) return finalPaths;
      await installBundledTailscale(bundled, target, binDir, finalPaths);
      return finalPaths;
    }
    failures.push(`platform package missing for ${target}`);
  } catch (error) {
    failures.push(describeError(error));
  }

  const system = await findSystem(target);
  if (system) return system;
  throw new Error(`tailscale binaries unavailable: ${failures.join("; ")}; install Tailscale (brew install tailscale) or build the platform package`);
}

/** macOS/Windows 的 GUI/服务进程 PATH 可能不含 Homebrew，显式探测常见前缀。 */
export async function findSystemTailscale(target: PlatformTarget = "darwin-arm64"): Promise<TailscaleBinaries | null> {
  const platform = target === "windows-amd64" ? "win32" : process.platform;
  const suffix = platform === "win32" ? ".exe" : "";
  const directories = new Set<string>();
  for (const value of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) directories.add(value);
  if (platform === "darwin") directories.add("/opt/homebrew/bin");
  if (platform !== "win32") { directories.add("/usr/local/bin"); directories.add("/usr/bin"); }
  for (const directory of directories) {
    const pair: TailscaleBinaries = {
      tailscale: resolve(directory, `tailscale${suffix}`),
      tailscaled: resolve(directory, `tailscaled${suffix}`),
    };
    if (await bothExecutable(pair)) return pair;
  }
  return null;
}

async function bothExecutable(pair: TailscaleBinaries): Promise<boolean> {
  for (const path of [pair.tailscale, pair.tailscaled]) {
    try { await access(path, constants.X_OK); } catch { return false; }
  }
  return true;
}

async function cachedPair(paths: TailscaleBinaries, hash: string): Promise<boolean> {
  for (const path of [paths.tailscale, paths.tailscaled]) {
    const marker = `${path}.source.sha256`;
    try {
      if (!(await stat(path)).isFile()) return false;
      if ((await readFile(marker, "utf8")).trim() !== hash) return false;
    } catch { return false; }
  }
  return true;
}

async function installBundledTailscale(
  asset: BundledTailscaleAsset,
  target: PlatformTarget,
  binDir: string,
  finalPaths: TailscaleBinaries,
): Promise<void> {
  const archiveInfo = await stat(asset.assetPath);
  if (!archiveInfo.isFile() || archiveInfo.size !== asset.size) throw new Error("bundled tailscale size mismatch");
  if ((await sha256File(asset.assetPath)) !== asset.sha256) throw new Error("bundled tailscale checksum mismatch");

  const temporaryDir = resolve(binDir, `.tailscale-${process.pid}-${Date.now()}`);
  await mkdir(temporaryDir, { recursive: true });
  try {
    await extractTgz(asset.assetPath, temporaryDir);
    const entries = (await readdir(temporaryDir)).sort();
    const expected = [...asset.entries].sort();
    if (entries.length !== expected.length || !entries.every((entry, index) => entry === expected[index])) {
      throw new Error(`unexpected bundled tailscale contents: ${entries.join(", ")}`);
    }
    for (const entry of asset.entries) {
      const destination = /^tailscale(?:\.exe)?$/.test(entry) ? finalPaths.tailscale : finalPaths.tailscaled;
      const extracted = resolve(temporaryDir, entry);
      if (!(await stat(extracted)).isFile()) throw new Error(`bundled tailscale executable missing: ${entry}`);
      if (target !== "windows-amd64") await chmod(extracted, 0o755);
      await copyFile(extracted, destination);
      const markerTemp = `${destination}.source.sha256.${process.pid}.tmp`;
      await writeFileAtomic(markerTemp, `${asset.sha256}\n`, `${destination}.source.sha256`);
    }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function writeFileAtomic(temporary: string, content: string, final: string): Promise<void> {
  await writeFile(temporary, content);
  await rename(temporary, final);
}

function describeError(error: unknown): string {
  const value = error as { message?: string; cause?: { code?: string; message?: string } };
  return [value.cause?.code, value.message, value.cause?.message].filter(Boolean).join(": ") || String(error);
}

function extractTgz(archive: string, dir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", dir], { stdio: "ignore" });
    child.once("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`tar exited ${code}`))));
    child.once("error", reject);
  });
}

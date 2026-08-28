import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import type { PlatformTarget } from "../platform.js";
import { resolveBundledCloudflared, type BundledCloudflaredAsset } from "./bundled-asset.js";
import { sha256File } from "./checksum.js";

interface EnsureCloudflaredOptions {
  resolveBundled?: (target: PlatformTarget) => Promise<BundledCloudflaredAsset | null>;
  findSystem?: (pathValue?: string, platform?: NodeJS.Platform) => Promise<string | null>;
}

export async function ensureCloudflared(
  target: PlatformTarget,
  dataDir: string,
  options: EnsureCloudflaredOptions = {},
): Promise<string> {
  const binDir = resolve(dataDir, "bin");
  const finalPath = resolve(binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  const marker = `${finalPath}.source.sha256`;
  await mkdir(binDir, { recursive: true });

  const resolveBundled = options.resolveBundled ?? resolveBundledCloudflared;
  const findSystem = options.findSystem ?? findSystemCloudflared;
  const failures: string[] = [];

  try {
    const bundled = await resolveBundled(target);
    if (bundled && (await cached(finalPath, marker, bundled.sha256))) return finalPath;
    if (bundled) return await installBundledCloudflared(bundled, binDir, finalPath, marker);
    failures.push(`platform package missing for ${target}`);
  } catch (error) {
    failures.push(describeError(error));
  }

  const systemBinary = await findSystem();
  if (systemBinary) return systemBinary;
  throw new Error(`cloudflared unavailable: ${failures.join("; ")}; no executable on PATH`);
}

export async function findSystemCloudflared(
  pathValue = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const name = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function installBundledCloudflared(
  asset: BundledCloudflaredAsset,
  binDir: string,
  finalPath: string,
  marker: string,
): Promise<string> {
  const archiveInfo = await stat(asset.archivePath);
  if (!archiveInfo.isFile() || archiveInfo.size !== asset.size) throw new Error("bundled cloudflared size mismatch");
  if ((await sha256File(asset.archivePath)) !== asset.sha256) throw new Error("bundled cloudflared checksum mismatch");

  const temporaryDir = resolve(binDir, `.cloudflared-${process.pid}-${Date.now()}`);
  const markerTemp = `${marker}.${process.pid}.tmp`;
  await mkdir(temporaryDir, { recursive: true });
  try {
    await extractTgz(asset.archivePath, temporaryDir);
    const entries = await readdir(temporaryDir);
    if (entries.length !== 1 || entries[0] !== asset.fileName) {
      throw new Error(`unexpected bundled cloudflared contents: ${entries.join(", ")}`);
    }
    const extracted = resolve(temporaryDir, asset.fileName);
    if (!(await stat(extracted)).isFile()) throw new Error("bundled cloudflared executable missing");
    if (process.platform !== "win32") await chmod(extracted, 0o755);
    await rename(extracted, finalPath);
    await writeFile(markerTemp, `${asset.sha256}\n`);
    await rename(markerTemp, marker);
    return finalPath;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
    await rm(markerTemp, { force: true });
  }
}

async function cached(path: string, marker: string, hash: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile() && (await readFile(marker, "utf8")).trim() === hash;
  } catch {
    return false;
  }
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

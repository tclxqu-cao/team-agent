import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UpdateChecker, buildDesktopAssetUrl, type UpdatePlatform, type UpdateStatus } from "@agent/core";

export interface DesktopUpdateDependencies {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  downloadsDirectory: string;
  reveal(path: string): void;
  fetch?: typeof fetch;
}

export class DesktopUpdateService {
  private readonly checker: UpdateChecker | null;
  private status: UpdateStatus;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private installPromise: Promise<UpdateStatus> | null = null;

  constructor(private readonly dependencies: DesktopUpdateDependencies) {
    const platform = desktopPlatform(dependencies.platform, dependencies.arch);
    this.status = { phase: platform ? "idle" : "unavailable", currentVersion: dependencies.version };
    this.checker = platform ? new UpdateChecker({ currentVersion: dependencies.version, client: "desktop", platform, fetch: dependencies.fetch }) : null;
    this.checker?.subscribe((status) => this.publish(status));
  }

  schedule(): void { this.checker?.schedule(); }
  getStatus(): UpdateStatus { return structuredClone(this.status); }
  subscribe(listener: (status: UpdateStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async check(): Promise<UpdateStatus> { return this.checker ? this.checker.refresh() : this.getStatus(); }

  install(): Promise<UpdateStatus> {
    if (this.installPromise) return this.installPromise;
    this.installPromise = this.download().finally(() => { this.installPromise = null; });
    return this.installPromise;
  }

  private async download(): Promise<UpdateStatus> {
    const candidate = this.checker?.getStatus();
    if (!candidate || candidate.phase !== "available" || !candidate.targetVersion || !candidate.asset) throw new Error("no validated Desktop update is available");
    await mkdir(this.dependencies.downloadsDirectory, { recursive: true });
    const destination = await availableDestination(this.dependencies.downloadsDirectory, candidate.asset.fileName);
    const partial = `${destination}.download`;
    this.publish({ ...candidate, phase: "downloading", progress: 0 });
    try {
      const response = await (this.dependencies.fetch ?? fetch)(buildDesktopAssetUrl(candidate.targetVersion, candidate.asset.fileName));
      if (!response.ok || !response.body) throw new Error("Desktop installer download failed");
      const expectedSize = Number(response.headers.get("content-length")) || candidate.asset.size || 0;
      let downloaded = 0;
      const source = Readable.fromWeb(response.body as any);
      source.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        if (expectedSize > 0) this.publish({ ...candidate, phase: "downloading", progress: Math.min(99, Math.round(downloaded / expectedSize * 100)) });
      });
      await pipeline(source, createWriteStream(partial, { flags: "wx", mode: 0o600 }));
      const actual = createHash("sha256").update(await readFile(partial)).digest("hex");
      if (actual !== candidate.asset.sha256) throw new Error("Desktop installer checksum mismatch");
      await rename(partial, destination);
      this.dependencies.reveal(destination);
      return this.publish({ ...candidate, phase: "complete", progress: 100, message: "安装包已下载，请手动安装" });
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      return this.publish({ ...candidate, phase: "failed", message: error instanceof Error ? error.message : "Desktop installer download failed" });
    }
  }

  private publish(status: UpdateStatus): UpdateStatus {
    this.status = status;
    for (const listener of this.listeners) listener(this.getStatus());
    return this.getStatus();
  }
}

export function desktopPlatform(platform: NodeJS.Platform, arch: string): UpdatePlatform | null {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "windows-amd64";
  return null;
}

async function availableDestination(directory: string, fileName: string): Promise<string> {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = resolve(directory, suffix === 0 ? fileName : `${stem}-${suffix}${extension}`);
    try { await access(candidate); } catch { return candidate; }
  }
  throw new Error("unable to allocate Desktop installer filename");
}

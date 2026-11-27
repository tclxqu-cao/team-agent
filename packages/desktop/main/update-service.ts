import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UpdateChecker, type DesktopEdition, type UpdatePlatform, type UpdateStatus } from "@agent/core";

export interface DesktopUpdateDependencies {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  edition: DesktopEdition;
  packaged: boolean;
  downloadsDirectory: string;
  activate(path: string, version: string): Promise<string>;
  fetch?: typeof fetch;
}

export class DesktopUpdateService {
  private readonly checker: UpdateChecker | null;
  private status: UpdateStatus;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private installPromise: Promise<UpdateStatus> | null = null;

  constructor(private readonly dependencies: DesktopUpdateDependencies) {
    const platform = dependencies.packaged ? desktopPlatform(dependencies.platform, dependencies.arch) : null;
    this.status = platform
      ? { phase: "idle", currentVersion: dependencies.version }
      : {
        phase: "unavailable", currentVersion: dependencies.version,
        message: dependencies.packaged
          ? "当前平台暂不支持应用内更新。"
          : "开发版从本地源码运行。更新源码并重新构建后即可使用新版本。",
      };
    this.checker = platform ? new UpdateChecker({
      currentVersion: dependencies.version, client: dependencies.edition, platform, fetch: dependencies.fetch, timeoutMs: 10_000,
    }) : null;
    this.checker?.subscribe((status) => {
      if (this.installPromise) return;
      if ((this.status.phase === "failed" || this.status.phase === "complete")
        && status.targetVersion === this.status.targetVersion && ["checking", "available"].includes(status.phase)) return;
      this.publish(status);
    });
  }

  schedule(): void { this.checker?.schedule(); }
  getStatus(): UpdateStatus { return structuredClone(this.status); }
  subscribe(listener: (status: UpdateStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async check(): Promise<UpdateStatus> {
    if (!this.installPromise) {
      const checked = await this.checker?.refresh({ force: true });
      if (checked?.message) return checked;
    }
    return this.getStatus();
  }

  install(): Promise<UpdateStatus> {
    if (this.installPromise) return this.installPromise;
    this.installPromise = this.download().finally(() => { this.installPromise = null; });
    return this.installPromise;
  }

  private async download(): Promise<UpdateStatus> {
    const candidate = this.checker?.getStatus();
    if (!candidate || candidate.phase !== "available" || !candidate.targetVersion || !candidate.asset?.url) {
      throw new Error("当前没有可安装的更新");
    }
    const { asset, targetVersion } = candidate;
    const url = candidate.asset.url;
    const publishProgress = (progress: number) => this.publish({ ...candidate, phase: "downloading", progress });
    let directory: string | undefined;
    publishProgress(0);
    try {
      await mkdir(this.dependencies.downloadsDirectory, { recursive: true });
      directory = await mkdtemp(join(this.dependencies.downloadsDirectory, "agentroam-update-"));
      const destination = join(directory, asset.fileName);
      const response = await (this.dependencies.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15 * 60_000) });
      if (!response.ok || !response.body) throw new Error("安装包下载失败");
      const expectedSize = asset.size ?? (Number(response.headers.get("content-length")) || 0);
      const limit = 2 * 1024 ** 3;
      const hash = createHash("sha256");
      let downloaded = 0;
      let progress = 0;
      const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
      await pipeline(source, async function* (source) {
        for await (const chunk of source) {
          downloaded += chunk.length;
          if (downloaded > (expectedSize || limit) || downloaded > limit) throw new Error("安装包大小异常");
          hash.update(chunk);
          const next = expectedSize ? Math.min(99, Math.floor(downloaded / expectedSize * 100)) : 0;
          if (next > progress) { progress = next; publishProgress(progress); }
          yield chunk;
        }
      }, createWriteStream(destination, { flags: "wx", mode: 0o700 }));
      if (hash.digest("hex") !== asset.sha256 || (asset.size && asset.size !== downloaded)) throw new Error("安装包校验失败");
      this.publish({ ...candidate, phase: "installing", progress: 100 });
      const message = await this.dependencies.activate(destination, targetVersion);
      return this.publish({ ...candidate, phase: "complete", progress: 100, message });
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
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

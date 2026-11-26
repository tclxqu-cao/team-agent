import { CapacitorHttp, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { UpdateChecker } from "../../../../core/src/domain/update/update-checker";
import { parseAgentRoamVersion, type UpdateStatus } from "../../../../core/src/domain/update/update-release";
import type { UpdateNoticeApi } from "../../../../desktop/renderer/components/UpdateNotice";

interface AndroidUpdatePlugin {
  getInfo(): Promise<{ version: string }>;
  install(options: { version: string; sha256: string }): Promise<void>;
  addListener(event: "progress", listener: (progress: Pick<UpdateStatus, "phase" | "progress" | "message">) => void): Promise<PluginListenerHandle>;
}

const nativeUpdate = registerPlugin<AndroidUpdatePlugin>("AgentRoamAppUpdate");

export class AndroidUpdateService implements UpdateNoticeApi {
  private checker: Promise<UpdateChecker | null> | undefined;
  private inFlight: Promise<UpdateStatus> | null = null;
  private operation: UpdateStatus | null = null;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();

  async getUpdateStatus(): Promise<UpdateStatus> {
    const checker = await this.getChecker();
    const status: UpdateStatus = checker?.getStatus() ?? { phase: "unavailable", currentVersion: "" };
    return this.operation && (this.inFlight || this.operation.targetVersion === status.targetVersion) ? this.operation : status;
  }

  async checkForUpdate(): Promise<UpdateStatus> {
    if (!this.inFlight) await (await this.getChecker())?.refresh();
    return this.getUpdateStatus();
  }

  installUpdate(): Promise<UpdateStatus> {
    return this.inFlight ??= this.install().finally(() => { this.inFlight = null; });
  }

  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private getChecker(): Promise<UpdateChecker | null> {
    return this.checker ??= nativeUpdate.getInfo().then(({ version }) => {
      if (!parseAgentRoamVersion(version)) return null;
      return new UpdateChecker({ currentVersion: version, client: "android", platform: "android", fetch: fetchReleaseMetadata, timeoutMs: 10_000 });
    }).catch(() => null);
  }

  private async install(): Promise<UpdateStatus> {
    const candidate = (await this.getChecker())?.getStatus();
    if (candidate?.phase !== "available" || !candidate.asset || !candidate.targetVersion) throw new Error("当前没有可安装的更新");
    let subscription: PluginListenerHandle | undefined;
    try {
      this.publish({ ...candidate, phase: "installing", message: "正在准备 Android 更新" });
      subscription = await nativeUpdate.addListener("progress", progress => this.publish({ ...candidate, ...progress }));
      await nativeUpdate.install({ version: candidate.targetVersion, sha256: candidate.asset.sha256 });
      return this.publish({ ...candidate, phase: "complete", message: "安装完成，请重新打开应用" });
    } catch (error) {
      return this.publish({ ...candidate, phase: "failed", message: error instanceof Error ? error.message : "Android 更新失败" });
    } finally {
      await subscription?.remove().catch(() => undefined);
    }
  }

  private publish(status: UpdateStatus): UpdateStatus {
    this.operation = status;
    for (const listener of this.listeners) listener(status);
    return status;
  }
}

// The release feed and checksum files live on github.com, outside WebView CORS.
// This adapter is only used for the fixed, public metadata requests in UpdateChecker.
const fetchReleaseMetadata: typeof fetch = async (input, init) => {
  if (init?.signal?.aborted) throw new Error("Update check timed out");
  const result = await CapacitorHttp.get({
    url: String(input),
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    responseType: "text",
    connectTimeout: 5_000,
    readTimeout: 5_000,
  });
  if (init?.signal?.aborted) throw new Error("Update check timed out");
  const body = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  return new Response([204, 205, 304].includes(result.status) ? null : body, { status: result.status, headers: result.headers });
};

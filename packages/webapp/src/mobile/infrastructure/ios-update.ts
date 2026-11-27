import { CapacitorHttp, registerPlugin } from "@capacitor/core";
import { UpdateChecker } from "../../../../core/src/domain/update/update-checker";
import { parseAgentRoamVersion, type UpdateStatus } from "../../../../core/src/domain/update/update-release";
import type { UpdateNoticeApi } from "../../../../desktop/renderer/components/UpdateNotice";

interface IosUpdatePlugin {
  getInfo(): Promise<{ version: string; bundleId: string; country?: string }>;
  openStore(options: { id: string }): Promise<void>;
}

interface StoreListing { bundleId?: unknown; trackId?: unknown; version?: unknown }

const nativeUpdate = registerPlugin<IosUpdatePlugin>("AgentRoamAppUpdate");
const NO_STORE_LISTING = "当前地区的 App Store 暂未提供更新，请通过原安装渠道检查。";
const NO_NATIVE_VERSION: UpdateStatus = { phase: "unavailable", currentVersion: "", message: "请通过原安装渠道检查 iOS 更新。" };

function storeVersion(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+){0,2}$/.test(value)) return null;
  const parts = value.split(".");
  while (parts.length < 3) parts.push("0");
  const version = parts.join(".");
  return parseAgentRoamVersion(version) ? version : null;
}

export class IosUpdateService implements UpdateNoticeApi {
  private checker: Promise<UpdateChecker | null> | undefined;
  private storeId: string | undefined;
  private unlisted = false;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();

  async getUpdateStatus(): Promise<UpdateStatus> {
    return this.withStoreMessage((await this.getChecker())?.getStatus() ?? NO_NATIVE_VERSION);
  }

  async checkForUpdate(): Promise<UpdateStatus> {
    return this.withStoreMessage(await (await this.getChecker())?.refresh({ force: true }) ?? NO_NATIVE_VERSION);
  }

  async installUpdate(): Promise<UpdateStatus> {
    const status = await this.getUpdateStatus();
    if (status.phase !== "available" || !this.storeId) throw new Error("当前没有可打开的 App Store 更新");
    await nativeUpdate.openStore({ id: this.storeId });
    return status;
  }

  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private getChecker(): Promise<UpdateChecker | null> {
    return this.checker ??= nativeUpdate.getInfo().then(({ version, bundleId, country }) => {
      const currentVersion = storeVersion(version);
      if (!currentVersion || !bundleId) return null;
      const checker = new UpdateChecker({
        client: "ios",
        currentVersion,
        readStoreVersion: () => this.readStoreVersion(bundleId, country),
      });
      checker.subscribe(status => {
        for (const listener of this.listeners) listener(this.withStoreMessage(status));
      });
      checker.schedule();
      return checker;
    }).catch(() => {
      this.checker = undefined;
      return null;
    });
  }

  private async readStoreVersion(bundleId: string, country?: string): Promise<string> {
    this.unlisted = false;
    const response = await CapacitorHttp.get({
      url: "https://itunes.apple.com/lookup",
      params: { bundleId, entity: "software", ...(country ? { country } : {}) },
      responseType: "json",
      connectTimeout: 5_000,
      readTimeout: 5_000,
    });
    const listings: StoreListing[] = response.data?.results;
    if (response.status !== 200 || !Array.isArray(listings)) throw new Error("App Store lookup unavailable");
    const listing = listings.find(item => item?.bundleId === bundleId);
    if (!listing) {
      this.unlisted = true;
      throw new Error(NO_STORE_LISTING);
    }
    const version = storeVersion(listing.version);
    const id = listing.trackId;
    if (!version || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error("Invalid App Store listing");
    }
    this.storeId = String(id);
    return version;
  }

  private withStoreMessage(status: UpdateStatus): UpdateStatus {
    return this.unlisted && status.message ? { ...status, message: NO_STORE_LISTING } : status;
  }
}

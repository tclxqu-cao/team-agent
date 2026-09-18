import {
  buildCliInstallManifestUrl,
  buildDesktopManifestUrl,
  compareAgentRoamVersions,
  parseAgentRoamVersion,
  parseChannelVersion,
  registryUrlsForChannel,
  resolveUpdateChannel,
  validateCliInstallManifest,
  validateReleaseManifest,
  type UpdateAsset,
  type UpdateChannel,
  type UpdateClient,
  type UpdatePlatform,
  type UpdateStatus,
} from "./update-release.js";

export interface UpdateCheckerOptions {
  currentVersion: string;
  client: UpdateClient;
  platform: UpdatePlatform;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  timeoutMs?: number;
  intervalMs?: number;
}

export class UpdateChecker {
  private status: UpdateStatus;
  private checkedAt = 0;
  private readonly etags = new Map<string, string>();
  private inFlight: Promise<UpdateStatus> | null = null;
  private readonly channel: UpdateChannel;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: NonNullable<UpdateCheckerOptions["setTimer"]>;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private scheduled = false;

  constructor(private readonly options: UpdateCheckerOptions) {
    if (!parseAgentRoamVersion(options.currentVersion)) throw new Error("invalid current AgentRoam version");
    this.channel = resolveUpdateChannel(options.currentVersion);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? setTimeout;
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1_000;
    this.status = { phase: "idle", currentVersion: options.currentVersion };
  }

  getStatus(): UpdateStatus {
    return structuredClone(this.status);
  }

  subscribe(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const delay = 6_000 + Math.floor(this.random() * 24_001);
    const timer = this.setTimer(() => {
      void this.refresh().finally(() => this.scheduleAfterInterval());
    }, delay);
    if (typeof timer === "object" && timer && "unref" in timer) (timer as NodeJS.Timeout).unref();
  }

  private scheduleAfterInterval(): void {
    const timer = this.setTimer(() => {
      void this.refresh().finally(() => this.scheduleAfterInterval());
    }, this.intervalMs);
    if (typeof timer === "object" && timer && "unref" in timer) (timer as NodeJS.Timeout).unref();
  }

  refresh(options: { force?: boolean } = {}): Promise<UpdateStatus> {
    if (this.inFlight) return this.inFlight;
    if (!options.force && this.checkedAt > 0 && this.now() - this.checkedAt < this.intervalMs) return Promise.resolve(this.getStatus());
    this.inFlight = this.runRefresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async runRefresh(): Promise<UpdateStatus> {
    const previous = this.status;
    this.publish({ ...previous, phase: "checking", message: undefined });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const candidate = await this.readRegistryCandidate(controller.signal);
      this.checkedAt = this.now();
      if (!candidate.version) {
        if (candidate.notModified) return this.publish({ ...previous, checkedAt: this.checkedAt });
        throw new Error("registry candidate unavailable");
      }
      const latest = candidate.version;
      if (compareAgentRoamVersions(latest, this.options.currentVersion) <= 0) {
        return this.publish({ phase: "up-to-date", currentVersion: this.options.currentVersion, checkedAt: this.checkedAt });
      }
      const asset = await this.readManifestAsset(latest, controller.signal);
      return this.publish({ phase: "available", currentVersion: this.options.currentVersion, targetVersion: latest, checkedAt: this.checkedAt, asset });
    } catch {
      this.checkedAt = this.now();
      if (["available", "up-to-date"].includes(previous.phase)) return this.publish({ ...previous, checkedAt: this.checkedAt });
      return this.publish({ phase: "unavailable", currentVersion: this.options.currentVersion, checkedAt: this.checkedAt });
    } finally {
      clearTimeout(timer);
    }
  }

  // CLI 安装器是版本无关脚本，读分支 raw 上的单份清单；桌面端安装包是构建产物，
  // 只能按版本读 Releases 资产清单。
  private async readManifestAsset(version: string, signal: AbortSignal): Promise<UpdateAsset> {
    const isCli = this.options.client === "cli";
    const url = isCli ? buildCliInstallManifestUrl() : buildDesktopManifestUrl(version);
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" }, signal });
    if (!response.ok) throw new Error("release manifest unavailable");
    const body = await response.json();
    return isCli
      ? validateCliInstallManifest(body, this.options.platform)
      : validateReleaseManifest(body, version, "desktop", this.options.platform).asset;
  }

  // Preview installations watch both the preview and latest npm dist-tags and
  // follow the higher version, so a newer stable release can pull them onto the
  // stable track. Stable installations only ever read latest.
  private async readRegistryCandidate(signal: AbortSignal): Promise<{ version: string | null; notModified: boolean }> {
    let best: string | null = null;
    let notModified = false;
    let sawResponse = false;
    for (const url of registryUrlsForChannel(this.channel)) {
      const headers: Record<string, string> = { accept: "application/json" };
      const etag = this.etags.get(url);
      if (etag) headers["if-none-match"] = etag;
      const response = await this.fetchImpl(url, { headers, signal });
      const responseEtag = response.headers.get("etag");
      if (responseEtag) this.etags.set(url, responseEtag);
      if (response.status === 304) { notModified = true; continue; }
      if (!response.ok) continue;
      sawResponse = true;
      const candidate = parseChannelVersion((await response.json() as { version?: unknown }).version, this.channel);
      if (!candidate) continue;
      if (!best || compareAgentRoamVersions(candidate, best) > 0) best = candidate;
    }
    return { version: best, notModified: notModified && !sawResponse };
  }

  private publish(status: UpdateStatus): UpdateStatus {
    this.status = status;
    for (const listener of this.listeners) listener(this.getStatus());
    return this.getStatus();
  }
}

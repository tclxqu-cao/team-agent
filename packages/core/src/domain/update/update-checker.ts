import {
  buildCliInstallManifestUrl,
  compareAgentRoamVersions,
  parseAgentRoamVersion,
  parseChannelVersion,
  registryUrlsForChannel,
  validateCliInstallManifest,
  type UpdatePlatform,
  type UpdateStatus,
} from "./update-release.js";
import { readAppRelease, type AppUpdateTarget } from "./app-release.js";

export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;

export type UpdateCheckerOptions = ({ client: "cli"; platform: UpdatePlatform } | AppUpdateTarget) & {
  currentVersion: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  timeoutMs?: number;
  intervalMs?: number;
};

export class UpdateChecker {
  private status: UpdateStatus;
  private checkedAt = 0;
  private readonly registryCache = new Map<string, { version: string; etag: string | null }>();
  private inFlight: Promise<UpdateStatus> | null = null;
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
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? setTimeout;
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
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
    try {
      const candidate = this.options.client === "cli"
        ? await this.readCliRelease(this.options.platform)
        : await readAppRelease(this.options, this.options.currentVersion, this.fetchImpl, this.timeoutMs);
      this.checkedAt = this.now();
      if (!candidate) {
        return this.publish({ phase: "up-to-date", currentVersion: this.options.currentVersion, checkedAt: this.checkedAt });
      }
      return this.publish({ phase: "available", currentVersion: this.options.currentVersion, targetVersion: candidate.version, checkedAt: this.checkedAt, asset: candidate.asset });
    } catch {
      this.checkedAt = this.now();
      if (["available", "up-to-date"].includes(previous.phase)) return this.publish({ ...previous, checkedAt: this.checkedAt });
      return this.publish({ phase: "unavailable", currentVersion: this.options.currentVersion, checkedAt: this.checkedAt });
    }
  }

  private async readCliRelease(platform: UpdatePlatform) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const version = await this.readRegistryCandidate(signal);
    if (compareAgentRoamVersions(version, this.options.currentVersion) <= 0) return null;
    const response = await this.fetchImpl(buildCliInstallManifestUrl(), { headers: { accept: "application/json" }, signal });
    if (!response.ok) throw new Error("CLI installer manifest unavailable");
    return { version, asset: validateCliInstallManifest(await response.json(), platform) };
  }

  private async readRegistryCandidate(signal: AbortSignal): Promise<string> {
    const results = await Promise.allSettled(registryUrlsForChannel("preview").map(async (url) => {
      const headers: Record<string, string> = { accept: "application/json" };
      const cached = this.registryCache.get(url);
      if (cached?.etag) headers["if-none-match"] = cached.etag;
      const response = await this.fetchImpl(url, { headers, signal });
      if (response.status === 304) return cached?.version;
      if (!response.ok) return undefined;
      const version = parseChannelVersion((await response.json() as { version?: unknown }).version, "preview");
      if (version) this.registryCache.set(url, { version, etag: response.headers.get("etag") });
      return version;
    }));
    let best: string | null = null;
    for (const result of results) {
      const candidate = result.status === "fulfilled" ? result.value : null;
      if (!candidate) continue;
      if (!best || compareAgentRoamVersions(candidate, best) > 0) best = candidate;
    }
    if (!best) throw new Error("npm release channel unavailable");
    return best;
  }

  private publish(status: UpdateStatus): UpdateStatus {
    this.status = status;
    for (const listener of this.listeners) listener(this.getStatus());
    return this.getStatus();
  }
}

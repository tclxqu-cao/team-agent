import {
  AGENTROAM_REGISTRY_LATEST_URL,
  buildGiteeManifestUrl,
  compareAgentRoamVersions,
  parseAgentRoamVersion,
  parseStableVersion,
  validateReleaseManifest,
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
  private etag: string | undefined;
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
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.etag) headers["if-none-match"] = this.etag;
      const registry = await this.fetchImpl(AGENTROAM_REGISTRY_LATEST_URL, { headers, signal: controller.signal });
      this.checkedAt = this.now();
      if (registry.status === 304) return this.publish({ ...previous, checkedAt: this.checkedAt });
      if (!registry.ok) throw new Error("registry unavailable");
      this.etag = registry.headers.get("etag") ?? this.etag;
      const latest = parseStableVersion((await registry.json() as { version?: unknown }).version);
      if (!latest) throw new Error("registry latest is not stable");
      if (compareAgentRoamVersions(latest, this.options.currentVersion) <= 0) {
        return this.publish({ phase: "up-to-date", currentVersion: this.options.currentVersion, checkedAt: this.checkedAt });
      }
      const manifestResponse = await this.fetchImpl(buildGiteeManifestUrl(latest), { headers: { accept: "application/json" }, signal: controller.signal });
      if (!manifestResponse.ok) throw new Error("release manifest unavailable");
      const { asset } = validateReleaseManifest(await manifestResponse.json(), latest, this.options.client, this.options.platform);
      return this.publish({ phase: "available", currentVersion: this.options.currentVersion, targetVersion: latest, checkedAt: this.checkedAt, asset });
    } catch {
      this.checkedAt = this.now();
      if (["available", "up-to-date"].includes(previous.phase)) return this.publish({ ...previous, checkedAt: this.checkedAt });
      return this.publish({ phase: "unavailable", currentVersion: this.options.currentVersion, checkedAt: this.checkedAt });
    } finally {
      clearTimeout(timer);
    }
  }

  private publish(status: UpdateStatus): UpdateStatus {
    this.status = status;
    for (const listener of this.listeners) listener(this.getStatus());
    return this.getStatus();
  }
}

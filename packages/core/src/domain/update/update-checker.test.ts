import { describe, expect, it, vi } from "vitest";
import { UpdateChecker } from "./update-checker.js";

const sha256 = "b".repeat(64);
const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...init.headers }, ...init });
// CLI 安装器清单是版本无关的：没有 version / channel / publishedAt 字段。
const cliInstallManifest = () => json({ schemaVersion: 1, installers: { "darwin-arm64": { fileName: "install-agentroam.sh", sha256 } } });
const desktopReleaseManifest = (version: string) => json({
  schemaVersion: 2,
  version,
  channel: version.includes("-preview.") ? "preview" : "latest",
  publishedAt: new Date().toISOString(),
  installers: { desktop: { "darwin-arm64": { fileName: `AgentRoam-${version}-arm64.dmg`, sha256, signed: false } } },
});

describe("UpdateChecker", () => {
  it("coalesces refreshes and validates npm then the CLI install manifest", async () => {
    let releaseRegistry!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRegistry = resolve; });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("registry")) { await gate; return json({ version: "1.1.0" }, { headers: { etag: '"one"' } }); }
      return cliInstallManifest();
    });
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "cli", platform: "darwin-arm64", fetch: fetcher as typeof fetch });
    const first = checker.refresh();
    const second = checker.refresh();
    expect(first).toBe(second);
    releaseRegistry();
    await expect(first).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the six-hour cache and retains an available result after failure", async () => {
    let now = 1;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ version: "1.1.0" }))
      .mockResolvedValueOnce(cliInstallManifest())
      .mockRejectedValueOnce(new Error("offline"));
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "cli", platform: "darwin-arm64", fetch: fetcher, now: () => now });
    await checker.refresh();
    await checker.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 6 * 60 * 60 * 1_000;
    await expect(checker.refresh()).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0" });
  });

  it("schedules the first check between six and thirty seconds", () => {
    let scheduledDelay = 0;
    const setTimer = vi.fn((_callback: () => void, delay: number) => {
      scheduledDelay = delay;
      return ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>;
    });
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "cli", platform: "darwin-arm64", random: () => 0.5, setTimer });
    checker.schedule();
    expect(scheduledDelay).toBeGreaterThanOrEqual(6_000);
    expect(scheduledDelay).toBeLessThanOrEqual(30_000);
  });

  it("preview users follow a higher preview", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/preview")) return json({ version: "1.1.0-preview.3" });
      if (u.endsWith("/latest")) return json({ version: "1.0.0" });
      return cliInstallManifest();
    });
    const checker = new UpdateChecker({ currentVersion: "1.1.0-preview.2", client: "cli", platform: "darwin-arm64", fetch: fetcher as typeof fetch });
    await expect(checker.refresh()).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0-preview.3" });
  });

  it("preview users migrate to a higher stable release", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/preview")) return json({ version: "1.1.0-preview.2" });
      if (u.endsWith("/latest")) return json({ version: "1.1.0" });
      return cliInstallManifest();
    });
    const checker = new UpdateChecker({ currentVersion: "1.1.0-preview.2", client: "cli", platform: "darwin-arm64", fetch: fetcher as typeof fetch });
    await expect(checker.refresh()).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0" });
  });

  it("stable users never read the preview tag", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      expect(u).not.toContain("/preview");
      if (u.includes("registry")) return json({ version: "1.1.0" });
      return cliInstallManifest();
    });
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "cli", platform: "darwin-arm64", fetch: fetcher as typeof fetch });
    await expect(checker.refresh()).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0" });
  });

  it("reads the per-version release manifest for the desktop client", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("registry")) return json({ version: "1.1.0" });
      expect(u).toContain("/v1.1.0/release-manifest.json");
      return desktopReleaseManifest("1.1.0");
    });
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "desktop", platform: "darwin-arm64", fetch: fetcher as typeof fetch });
    await expect(checker.refresh()).resolves.toMatchObject({
      phase: "available",
      targetVersion: "1.1.0",
      asset: { fileName: "AgentRoam-1.1.0-arm64.dmg" },
    });
  });

  it("reports unavailable when the CLI install manifest fails to validate", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("registry")) return json({ version: "1.1.0" });
      return json({ schemaVersion: 1, installers: {} });
    });
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "cli", platform: "darwin-arm64", fetch: fetcher as typeof fetch });
    await expect(checker.refresh()).resolves.toMatchObject({ phase: "unavailable" });
  });
});

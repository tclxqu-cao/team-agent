import { describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_INTERVAL_MS, UpdateChecker } from "./update-checker.js";
import { AGENTROAM_RELEASE_BASE, AGENTROAM_REPOSITORY_BASE } from "./update-release.js";

const sha256 = "b".repeat(64);
const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...init.headers }, ...init });
// CLI 安装器清单是版本无关的：没有 version / channel / publishedAt 字段。
const cliInstallManifest = () => json({ schemaVersion: 1, installers: { "darwin-arm64": { fileName: "install-agentroam.sh", sha256 } } });
const release = (tag: string, fileName: string, draft = false) => ({
  tag_name: tag, draft, published_at: "2026-11-26T00:00:00Z",
  assets: [{ name: fileName, state: "uploaded", size: 12, digest: `sha256:${sha256}`, browser_download_url: `${AGENTROAM_RELEASE_BASE}/${tag}/${fileName}` }],
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
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("uses the five-minute cache and retains an available result after failure", async () => {
    let now = 1;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ version: "1.1.0" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(cliInstallManifest())
      .mockRejectedValue(new Error("offline"));
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "cli", platform: "darwin-arm64", fetch: fetcher, now: () => now });
    await checker.refresh();
    await checker.refresh();
    expect(fetcher).toHaveBeenCalledTimes(3);
    now += UPDATE_CHECK_INTERVAL_MS;
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

  it("offers a higher published preview after a stable version", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/preview")) return json({ version: "1.2.0-preview.1" });
      if (u.endsWith("/latest")) return json({ version: "1.1.0" });
      return cliInstallManifest();
    });
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "cli", platform: "darwin-arm64", fetch: fetcher as typeof fetch });
    await expect(checker.refresh()).resolves.toMatchObject({ phase: "available", targetVersion: "1.2.0-preview.1" });
  });

  it("compares the numeric version of the exact public platform and edition asset", async () => {
    const fetcher = vi.fn(async () => json([
      release("desktop-v1.4.0", "AgentRoam-1.4.0-arm64.dmg"),
      release("desktop-lite-v1.3.0", "AgentRoam-Lite-1.3.0-arm64.dmg", true),
      release("desktop-lite-v1.2.0", "AgentRoam-Lite-1.2.0-arm64.dmg"),
      release("desktop-lite-v1.1.0-preview.2", "AgentRoam-Lite-Setup-1.1.0-preview.2-x64.exe"),
      release("desktop-lite-v1.1.0-preview.12", "AgentRoam-Lite-Setup-1.1.0-preview.12-x64.exe"),
      release("android-v1.5.0", "AgentRoam-1.5.0-android.apk"),
    ]));
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "desktop-lite", platform: "windows-amd64", fetch: fetcher });
    await expect(checker.refresh()).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0-preview.12",
      asset: { fileName: "AgentRoam-Lite-Setup-1.1.0-preview.12-x64.exe", sha256 } });
  });

  it("falls back to the edition release search and the exact APK checksum when GitHub REST is rate limited", async () => {
    const tagLink = (tag: string) => `<a href="${new URL(AGENTROAM_REPOSITORY_BASE).pathname}/releases/tag/${tag}">release</a>`;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(tagLink("desktop-v1.3.0")))
      .mockResolvedValueOnce(new Response(`${tagLink("android-v1.2.0")}${tagLink("android-v1.1.0")}`))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(`${sha256}  AgentRoam-1.1.0-android.apk\n`));
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "android", platform: "android", fetch: fetcher });
    await expect(checker.refresh()).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0",
      asset: { fileName: "AgentRoam-1.1.0-android.apk", sha256, url: `${AGENTROAM_RELEASE_BASE}/android-v1.1.0/AgentRoam-1.1.0-android.apk` } });
  });

  it("keeps the higher CLI tag after a cached 304 and a lower tag response", async () => {
    let now = 1;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/latest")) return json({ version: "1.0.0" });
      if (url.endsWith("/preview")) return new Headers(init?.headers).has("if-none-match")
        ? new Response(null, { status: 304 }) : json({ version: "1.1.0-preview.2" }, { headers: { etag: '"preview"' } });
      return cliInstallManifest();
    });
    const checker = new UpdateChecker({ currentVersion: "1.0.0", client: "cli", platform: "darwin-arm64", now: () => now, fetch: fetcher as typeof fetch });
    await expect(checker.refresh()).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0-preview.2" });
    now += UPDATE_CHECK_INTERVAL_MS;
    await expect(checker.refresh()).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0-preview.2" });
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

import { describe, expect, it, vi } from "vitest";
import { UpdateChecker } from "./update-checker.js";

const sha256 = "b".repeat(64);
const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...init.headers }, ...init });

describe("UpdateChecker", () => {
  it("coalesces refreshes and validates npm then Gitee", async () => {
    let releaseRegistry!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRegistry = resolve; });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("registry")) { await gate; return json({ version: "1.1.0" }, { headers: { etag: '"one"' } }); }
      return json({ schemaVersion: 2, version: "1.1.0", channel: "latest", publishedAt: new Date().toISOString(), installers: { cli: { "darwin-arm64": { fileName: "install-agentroam.sh", sha256 } } } });
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
      .mockResolvedValueOnce(json({ schemaVersion: 2, version: "1.1.0", channel: "latest", publishedAt: new Date().toISOString(), installers: { cli: { "darwin-arm64": { fileName: "install-agentroam.sh", sha256 } } } }))
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
});

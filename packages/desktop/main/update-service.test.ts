import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdateService, desktopPlatform } from "./update-service.js";

const directories: string[] = [];
const tag = "desktop-lite-v1.1.0-preview.1";
const fileName = "AgentRoam-Lite-1.1.0-preview.1-arm64.dmg";
const url = `https://github.com/tclxqu-cao/team-agent/releases/download/${tag}/${fileName}`;

async function fixture(download: string) {
  const bytes = "installer";
  const directory = await mkdtemp(resolve(tmpdir(), "agentroam-desktop-update-"));
  directories.push(directory);
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === url) return new Response(download);
    return Response.json([{
      tag_name: tag, draft: false, published_at: "2026-11-26T00:00:00Z",
      assets: [{ name: fileName, state: "uploaded", size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, browser_download_url: url }],
    }]);
  });
  const activate = vi.fn(async (_path: string, _version: string) => "安装已启动");
  const service = new DesktopUpdateService({
    version: "1.0.0", platform: "darwin", arch: "arm64", edition: "desktop-lite", packaged: true,
    downloadsDirectory: directory, fetch, activate,
  });
  return { service, activate, directory, fetch };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("DesktopUpdateService contract", () => {
  it("allowlists only native release targets", () => {
    expect(desktopPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(desktopPlatform("win32", "x64")).toBe("windows-amd64");
    expect(desktopPlatform("linux", "x64")).toBeNull();
  });

  it("checks metadata without downloading, then hands off the verified Lite package only once", async () => {
    const { service, fetch, activate } = await fixture("installer");
    await expect(service.check()).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0-preview.1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    const first = service.install();
    expect(service.install()).toBe(first);
    await expect(first).resolves.toMatchObject({ phase: "complete", message: "安装已启动" });
    expect(activate).toHaveBeenCalledTimes(1);
    const [path, version] = activate.mock.calls[0];
    await expect(readFile(path, "utf8")).resolves.toBe("installer");
    expect(version).toBe("1.1.0-preview.1");
  });

  it("removes a bad download and keeps the old app running", async () => {
    const { service, activate, directory } = await fixture("corrupted");
    await service.check();
    await expect(service.install()).resolves.toMatchObject({ phase: "failed", message: "安装包校验失败" });
    expect(activate).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePrivateFile,
  readServiceConfig,
  resolveServicePaths,
  writePrivateJson,
  writePrivateText,
  type ServiceConfig,
} from "./service-files.js";

describe("service files", () => {
  it("resolves control files under the home directory and runtime files under data-dir", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-service-home-"));
    const data = resolve(home, "custom-data");
    const paths = resolveServicePaths(home, data);

    expect(paths.plistPath).toBe(resolve(home, "Library/LaunchAgents/com.agentroam.service.plist"));
    expect(paths.configPath).toBe(resolve(home, ".agentroam/service/config.json"));
    expect(paths.statePath).toBe(resolve(home, ".agentroam/service/state.json"));
    expect(paths.urlPath).toBe(resolve(data, "tunnel.url"));
    expect(paths.stdoutPath).toBe(resolve(data, "logs/service.stdout.log"));
  });

  it("atomically replaces private JSON and text files", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-service-private-"));
    const paths = resolveServicePaths(home);
    const first = config(paths.dataDir, "first");
    const second = config(paths.dataDir, "second");

    await writePrivateJson(paths.configPath, first);
    await writePrivateJson(paths.configPath, second);
    await writePrivateText(paths.urlPath, "https://example.trycloudflare.com/web\n");
    await ensurePrivateFile(paths.stdoutPath);

    expect(await readServiceConfig(paths)).toEqual(second);
    expect(await readFile(paths.urlPath, "utf8")).toContain("trycloudflare.com");
    for (const path of [paths.configPath, paths.urlPath, paths.stdoutPath]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    expect((await stat(paths.controlDir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.logsDir)).mode & 0o777).toBe(0o700);
  });
});

function config(dataDir: string, version: string): ServiceConfig {
  return {
    version,
    nodePath: "/node",
    cliPath: "/agentroam.mjs",
    roots: ["/workspace"],
    port: null,
    relay: "auto",
    tunnelCommand: null,
    localOnly: false,
    dataDir,
    installedAt: "2026-09-03T00:00:00.000Z",
  };
}

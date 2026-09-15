import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ServiceRuntimeReporter } from "./runtime-state.js";
import { readServiceState, resolveServicePaths, writePrivateJson } from "./service-files.js";

describe("ServiceRuntimeReporter", () => {
  it("publishes starting, ready, and stopped state without leaving a stale URL", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-service-state-"));
    const paths = resolveServicePaths(home);
    let tick = 0;
    const reporter = new ServiceRuntimeReporter(paths, "0.2.0-preview.9", 123, () => new Date(1_000 + tick++));

    await reporter.starting();
    expect(await readServiceState(paths)).toMatchObject({ status: "starting", pid: 123, version: "0.2.0-preview.9" });
    await expect(access(paths.urlPath)).rejects.toMatchObject({ code: "ENOENT" });

    await reporter.localReady("http://127.0.0.1:49157");
    expect(await readServiceState(paths)).toMatchObject({status:"starting",localUrl:"http://127.0.0.1:49157",pid:123});
    await expect(access(paths.urlPath)).rejects.toMatchObject({code:"ENOENT"});

    await reporter.ready({
      localUrl: "http://127.0.0.1:3000",
      publicUrl: "https://example.trycloudflare.com",
      accessUrl: "https://example.trycloudflare.com/web?pair=secret",
      provider: "cloudflare",
    });
    expect(await readServiceState(paths)).toMatchObject({ status: "ready", provider: "cloudflare" });
    expect(await readFile(paths.urlPath, "utf8")).toBe("https://example.trycloudflare.com/web?pair=secret\n");

    expect(await reporter.stopped()).toBe(true);
    expect(await readServiceState(paths)).toMatchObject({ status: "stopped", pid: 123 });
    await expect(access(paths.urlPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let an older process clear a newer process state", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "agentroam-service-state-race-"));
    const paths = resolveServicePaths(home);
    const reporter = new ServiceRuntimeReporter(paths, "old", 123);
    await writePrivateJson(paths.statePath, {
      status: "ready",
      pid: 456,
      version: "new",
      startedAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:01.000Z",
      accessUrl: "https://new.example/web",
    });

    expect(await reporter.stopped()).toBe(false);
    expect(await readServiceState(paths)).toMatchObject({ status: "ready", pid: 456 });
  });
});

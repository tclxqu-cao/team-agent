import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliOptions, ServiceAction } from "../args.js";
import type { ServiceController } from "./service-controller.js";
import { buildServiceEnvironmentPath, runServiceCommand } from "./service-command.js";

describe("runServiceCommand", () => {
  it("installs the service using absolute runtime context and parsed start options", async () => {
    const install = vi.fn(async (config) => ({
      paths: { plistPath: "/Users/test/Library/LaunchAgents/com.agentroam.service.plist" },
      state: { status: "ready", accessUrl: "https://ready.example/web" },
      definition: "/Users/test/Library/LaunchAgents/com.agentroam.service.plist",
    }));
    const log = vi.fn();

    await runServiceCommand(options("install"), {
      platform: "darwin",
      nodePath: "/node",
      cliPath: "/agentroam.mjs",
      version: "0.2.0-preview.9",
      nodeVersion: "22.22.0",
      environment: { PATH: "/nvm/versions/node/v22.22.0/bin:/usr/bin", CODEX_HOME: "/Users/test/.custom-codex" },
      codexResolver: vi.fn(async () => ({ executable: "/nvm/versions/node/v22.22.0/bin/codex", version: "0.153.0", source: "global" as const })),
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      log,
      controller: controller({ install }),
    });

    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      nodePath: "/node",
      cliPath: "/agentroam.mjs",
      roots: [resolve("workspace")],
      version: "0.2.0-preview.9",
      environmentPath: "/:/nvm/versions/node/v22.22.0/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      codexPath: "/nvm/versions/node/v22.22.0/bin/codex",
      codexHome: "/Users/test/.custom-codex",
      installedAt: "2026-09-03T00:00:00.000Z",
    }));
    expect(log).toHaveBeenCalledWith("Open: https://ready.example/web");
  });

  it("pins the selected Node directory ahead of the inherited service PATH", () => {
    expect(buildServiceEnvironmentPath(
      "/Users/test/.nvm/versions/node/v22.22.2/bin/node",
      "/usr/bin:/Users/test/.nvm/versions/node/v22.22.2/bin",
      "darwin",
    )).toBe("/Users/test/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("reports status without mutating an uninstalled service", async () => {
    const log = vi.fn();
    await runServiceCommand(options("status"), {
      platform: "darwin",
      nodePath: "/node",
      cliPath: "/agentroam.mjs",
      version: "test",
      log,
      controller: controller({ status: vi.fn(async () => ({ installed: false })) }),
    });
    expect(log).toHaveBeenCalledWith("AgentRoam service: not installed");
  });

  it("starts and stops a Windows service through the same command contract", async () => {
    const start = vi.fn(async () => ({ status: "ready", accessUrl: "https://ready.example/web" }));
    const stop = vi.fn(async () => undefined);
    const log = vi.fn();

    await runServiceCommand(options("start"), {
      platform: "win32",
      nodePath: "C:\\node.exe",
      cliPath: "C:\\agentroam.mjs",
      version: "test",
      controller: controller({ start }),
      log,
    });
    await runServiceCommand(options("stop"), {
      platform: "win32",
      nodePath: "C:\\node.exe",
      cliPath: "C:\\agentroam.mjs",
      version: "test",
      controller: controller({ stop }),
      log,
    });

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("✓ AgentRoam service started");
    expect(log).toHaveBeenCalledWith("✓ AgentRoam service stopped");
  });

  it("rejects service management outside supported platforms", async () => {
    await expect(runServiceCommand(options("status"), {
      platform: "linux",
      nodePath: "/node",
      cliPath: "/agentroam.mjs",
      version: "test",
    })).rejects.toThrow("supported platforms are macOS and Windows");
  });
});

function controller(overrides: Record<string, unknown>): ServiceController {
  return {
    install: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    status: vi.fn(),
    url: vi.fn(),
    logs: vi.fn(),
    restart: vi.fn(),
    uninstall: vi.fn(),
    ...overrides,
  } as ServiceController;
}

function options(serviceAction: ServiceAction): CliOptions {
  return {
    command: "service",
    serviceAction,
    roots: [resolve("workspace")],
    port: null,
    relay: "auto",
    tunnelCommand: null,
    localOnly: false,
    qr: false,
    dataDir: resolve("data"),
  };
}

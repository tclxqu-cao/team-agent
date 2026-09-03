import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliOptions, ServiceAction } from "../args.js";
import { runServiceCommand } from "./service-command.js";

describe("runServiceCommand", () => {
  it("installs the service using absolute runtime context and parsed start options", async () => {
    const install = vi.fn(async (config) => ({
      paths: { plistPath: "/Users/test/Library/LaunchAgents/com.agentroam.service.plist" },
      state: { status: "ready", accessUrl: "https://ready.example/web" },
    }));
    const log = vi.fn();

    await runServiceCommand(options("install"), {
      platform: "darwin",
      nodePath: "/node",
      cliPath: "/agentroam.mjs",
      version: "0.2.0-preview.9",
      nodeVersion: "22.22.0",
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      log,
      launchAgent: { install } as never,
    });

    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      nodePath: "/node",
      cliPath: "/agentroam.mjs",
      roots: [resolve("workspace")],
      version: "0.2.0-preview.9",
      installedAt: "2026-09-03T00:00:00.000Z",
    }));
    expect(log).toHaveBeenCalledWith("Open: https://ready.example/web");
  });

  it("reports status without mutating an uninstalled service", async () => {
    const log = vi.fn();
    await runServiceCommand(options("status"), {
      platform: "darwin",
      nodePath: "/node",
      cliPath: "/agentroam.mjs",
      version: "test",
      log,
      launchAgent: { status: vi.fn(async () => ({ installed: false })) } as never,
    });
    expect(log).toHaveBeenCalledWith("AgentRoam service: not installed");
  });

  it("rejects service management outside macOS", async () => {
    await expect(runServiceCommand(options("status"), {
      platform: "win32",
      nodePath: "C:\\node.exe",
      cliPath: "C:\\agentroam.mjs",
      version: "test",
    })).rejects.toThrow("only on macOS");
  });
});

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

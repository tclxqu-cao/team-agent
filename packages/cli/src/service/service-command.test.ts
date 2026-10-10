import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliOptions, ServiceAction } from "../args.js";
import type { ServiceController } from "./service-controller.js";
import { buildServiceEnvironmentPath, runServiceCommand } from "./service-command.js";
import { withCliProgress } from "../../bin/cli-progress.mjs";

describe("runServiceCommand", () => {
  it("shows progress while start waits for readiness and stops after failure", async () => {
    vi.useFakeTimers();
    try {
      const progress = vi.fn();
      const pending = withCliProgress("服务命令", () => runServiceCommand(options("start"), {
        platform: "darwin", nodePath: "/node", cliPath: "/cli", version: "test", log: vi.fn(),
        controller: controller({ start: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 6000));
          return null;
        }) }),
      }), { log: progress });
      const failed = expect(pending).rejects.toThrow("后台服务未就绪");
      await vi.advanceTimersByTimeAsync(5800);
      expect(progress).toHaveBeenCalledTimes(2);
      expect(progress).toHaveBeenLastCalledWith(expect.stringContaining("正在启动后台服务，等待服务和手机访问连接就绪（已等待 5 秒）"));
      await vi.advanceTimersByTimeAsync(200);
      await failed;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])("runs native authorization before Desktop setup and pairing, retaining installation after failure=%s", async (fails) => {
    const order: string[] = [];
    const log = vi.fn();
    const desktopAuthorization = vi.fn(async () => { order.push("authorization"); if (fails) throw new Error("cancelled permission"); return true; });
    await runServiceCommand({ ...options("install"), desktopSetup: true }, {
      platform: "darwin", nodePath: "/node", nodeVersion: "22.22.0", cliPath: "/agentroam.mjs", version: "test", isTTY: true,
      environment: {}, log, desktopAuthorization,
      desktopSetup: vi.fn(async () => { order.push("desktop"); }), pairingPrinter: vi.fn(async () => { order.push("pairing"); }),
      controller: controller({ install: vi.fn(async () => ({ definition: "service", state: { status: "ready", accessUrl: "https://ready.example/web", localUrl: "http://127.0.0.1:4317" } })) }),
      codexResolver: vi.fn(async () => ({ executable: "/managed/codex", version: "test", source: "global" as const })),
    });
    expect(order).toEqual(["authorization", "desktop", "pairing"]);
    expect(desktopAuthorization).toHaveBeenCalledWith(options("install").dataDir, expect.objectContaining({ isTTY: true, platform: "darwin" }));
    if (fails) expect(log).toHaveBeenCalledWith(expect.stringContaining("AgentRoam 安装继续"));
  });

  it("allows unattended installs to skip desktop authorization without losing pairing", async () => {
    const desktopAuthorization = vi.fn();
    const pairingPrinter = vi.fn();
    await runServiceCommand(options("install"), {
      platform: "darwin", nodePath: "/node", nodeVersion: "22.22.0", cliPath: "/agentroam.mjs", version: "test",
      environment: { AGENTROAM_INSTALL_REMOTE_DESKTOP: "skip" }, log: vi.fn(), desktopAuthorization, pairingPrinter,
      controller: controller({ install: vi.fn(async () => ({ definition: "service", state: { status: "ready", accessUrl: "https://ready.example/web", localUrl: "http://127.0.0.1:4317" } })) }),
      codexResolver: vi.fn(async () => ({ executable: "/managed/codex", version: "test", source: "global" as const })),
    });
    expect(desktopAuthorization).not.toHaveBeenCalled();
    expect(pairingPrinter).toHaveBeenCalledOnce();
  });
  it.each(["22.22.0", "24.0.0", "25.8.0", "26.0.0"])("keeps the selected Node %s when installing a service", async (nodeVersion) => {
    const install = vi.fn(async () => ({ definition: "/test/service.plist", state: { status: "ready", accessUrl: "https://ready.example/web" } }));
    const nodePath = `/runtimes/node-${nodeVersion}/bin/node`;
    const codexResolver = vi.fn(async () => ({ executable: "/tools/codex", version: "test", source: "global" as const }));
    await runServiceCommand(options("install"), {
      platform: "darwin", arch: "arm64", nodeVersion, nodePath,
      cliPath: "/agentroam.mjs", version: "test", environment: { PATH: "/usr/bin" },
      codexResolver, controller: controller({ install }), log: vi.fn(), pairingPrinter: vi.fn(),
    });
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ nodePath }));
    expect(codexResolver).toHaveBeenCalledWith(expect.objectContaining({ nodeExecutable: nodePath }));
  });

  it("rejects a below-minimum service runtime before installation", async () => {
    const install = vi.fn();
    await expect(runServiceCommand(options("install"), {
      platform: "darwin", nodePath: "/node", nodeVersion: "22.21.9", cliPath: "/agentroam.mjs",
      version: "test", controller: controller({ install }),
    })).rejects.toThrow("Node.js >=22.22.0");
    expect(install).not.toHaveBeenCalled();
  });

  it("installs the service using absolute runtime context and parsed start options", async () => {
    const install = vi.fn(async (config) => ({
      paths: { plistPath: "/Users/test/Library/LaunchAgents/com.agentroam.service.plist" },
      state: { status: "ready", accessUrl: "https://ready.example/web", localUrl: "http://127.0.0.1:4317/" },
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
      pairingPrinter: vi.fn(async () => {}),
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
    expect(log).toHaveBeenCalledWith("远程桌面授权地址：http://127.0.0.1:4317/web");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("屏幕录制"));
  });

  it("prints a scannable QR code after the URL on interactive terminals", async () => {
    const log = vi.fn();
    await runServiceCommand({ ...options("start"), qr: true }, {
      platform: "darwin",
      nodePath: "/node",
      cliPath: "/agentroam.mjs",
      version: "test",
      isTTY: true,
      log,
      controller: controller({ start: vi.fn(async () => ({ status: "ready", accessUrl: "https://ready.example/web" })) }),
    });
    const openIndex = log.mock.calls.findIndex(([line]) => line === "Open: https://ready.example/web");
    expect(openIndex).toBeGreaterThanOrEqual(0);
    const qr = log.mock.calls[openIndex + 2]?.[0] as string | undefined;
    expect(qr).toMatch(/[▀▄█]/);
    expect(qr).toContain("\n");
  });

  it("finishes installer Desktop setup before creating a fresh pairing code", async () => {
    const order: string[] = [];
    const desktopSetup = vi.fn(async () => { order.push("desktop"); });
    const pairingPrinter = vi.fn(async () => { order.push("pairing"); });
    await runServiceCommand({ ...options("install"), desktopSetup: true }, {
      platform: "darwin", nodePath: "/node", nodeVersion: "22.22.0", cliPath: "/agentroam.mjs", version: "test",
      environment: {}, log: vi.fn(), desktopSetup, pairingPrinter,
      controller: controller({ install: vi.fn(async () => ({ definition: "service", state: { status: "ready", accessUrl: "https://ready.example/web" } })) }),
      codexResolver: vi.fn(async () => ({ executable: "/managed/codex", version: "test", source: "global" as const })),
    });
    expect(order).toEqual(["desktop", "pairing"]);
    expect(desktopSetup).toHaveBeenCalledWith(expect.objectContaining({ desktopSetup: true }), expect.objectContaining({ service: expect.objectContaining({ codexPath: "/managed/codex" }) }));
  });

  it.each(["install", "start", "restart"] as const)("returns a failure for %s when service readiness was not reached", async (action) => {
    for (const platform of ["darwin", "win32"] as const) {
      for (const state of [null, { status: "starting" }, { status: "stopped" }, { status: "ready" }]) {
        const log = vi.fn();
        const desktopSetup = vi.fn();
        const pairingPrinter = vi.fn();
        const control = controller({
          install: vi.fn(async () => ({ definition: "service", state })),
          start: vi.fn(async () => state), restart: vi.fn(async () => state),
        });
        await expect(runServiceCommand({ ...options(action), desktopSetup: true }, {
          platform, nodePath: "/node", nodeVersion: "22.22.0", cliPath: "/agentroam.mjs", version: "test",
          controller: control, log, desktopSetup, pairingPrinter, environment: {},
          codexResolver: vi.fn(async () => ({ executable: "/codex", version: "test", source: "global" as const })),
        })).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining("agentroam service logs") });
        expect(log.mock.calls.some(([line]) => /service (?:started|restarted)|Open:/.test(line))).toBe(false);
        expect(desktopSetup).not.toHaveBeenCalled();
        expect(pairingPrinter).not.toHaveBeenCalled();
      }
    }
  });

  it("keeps service output QR-free when piped or when --no-qr is set", async () => {
    const log = vi.fn();
    const start = vi.fn(async () => ({ status: "ready", accessUrl: "https://ready.example/web" }));
    await runServiceCommand({ ...options("start"), qr: true }, {
      platform: "darwin",
      nodePath: "/node",
      cliPath: "/agentroam.mjs",
      version: "test",
      isTTY: false,
      log,
      controller: controller({ start }),
    });
    await runServiceCommand(options("start"), {
      platform: "darwin",
      nodePath: "/node",
      cliPath: "/agentroam.mjs",
      version: "test",
      isTTY: true,
      log,
      controller: controller({ start }),
    });
    const lines = log.mock.calls.map(([line]) => line);
    expect(lines).toContain("Open: https://ready.example/web");
    expect(lines.some((line) => /[▀▄█]/.test(String(line)))).toBe(false);
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
    unlockServiceAction: null,
    roots: [resolve("workspace")],
    port: null,
    relay: "auto",
    tunnelCommand: null,
    localOnly: false,
    qr: false,
    dataDir: resolve("data"),
  };
}

it.each(['install', 'start', 'restart', 'status'] as const)('prints the actual Windows local address for %s before tunnel readiness', async (action) => {
  const state = {status:'starting',localUrl:'http://127.0.0.1:49157',pid:123};
  const log=vi.fn();
  const control=controller({
    install:vi.fn(async()=>({state,definition:'task'})),start:vi.fn(async()=>state),restart:vi.fn(async()=>state),
    status:vi.fn(async()=>({installed:true,running:true,state,config:null})),
  });
  const command = runServiceCommand(options(action),{platform:'win32',arch:'x64',nodePath:'C:\\node.exe',cliPath:'C:\\agentroam.mjs',version:'test',nodeVersion:'22.22.0',controller:control,log,
    codexResolver:vi.fn(async()=>({executable:'C:\\codex.exe',version:'test',source:'global' as const}))});
  if (action === 'status') await command;
  else await expect(command).rejects.toThrow('后台服务未就绪');
  expect(log).toHaveBeenCalledWith('远程桌面授权地址：http://127.0.0.1:49157/web');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('保持 Windows 已登录'));
  expect(log.mock.calls.some(([line])=>line.includes('屏幕录制')||line.includes('辅助功能'))).toBe(false);
});

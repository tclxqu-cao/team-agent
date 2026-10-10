import { printLocalDesktopUrl } from '../local-desktop-url.js';
import { delimiter, dirname, isAbsolute, resolve, win32 } from "node:path";
import type { CliOptions } from "../args.js";
import { resolveCodexRuntime, type CodexRuntimeResolution, type ResolveCodexRuntimeOptions } from "../codex-runtime-manager.js";
import { detectPlatform } from "../platform.js";
import { printPairingCode } from "../device-pairing.js";
import { renderQr } from "../qr.js";
import { MacLaunchAgent } from "./macos-launch-agent.js";
import type { ServiceConfig, ServiceRuntimeState } from "./service-files.js";
import type { ServiceController } from "./service-controller.js";
import { WindowsTaskService } from "./windows-task-service.js";
import { assertSupportedNodeVersion } from "../../bin/runtime-policy.mjs";
import { cleanupOldLaunchers } from "./launcher-cleanup.js";
import { setupCodexDesktop } from "../codex-desktop-setup.js";
import { authorizeRemoteDesktop } from "../desktop-authorization.js";
import { withCliProgress } from "../../bin/cli-progress.mjs";

interface ServiceCommandContext {
  platform?: NodeJS.Platform;
  homeDir?: string;
  nodePath: string;
  cliPath: string;
  version: string;
  nodeVersion?: string;
  arch?: string;
  environment?: NodeJS.ProcessEnv;
  codexResolver?: (options: ResolveCodexRuntimeOptions) => Promise<CodexRuntimeResolution>;
  now?: () => Date;
  log?: (line: string) => void;
  isTTY?: boolean;
  pairingPrinter?: typeof printPairingCode;
  controller?: ServiceController;
  launchAgent?: MacLaunchAgent;
  desktopSetup?: typeof setupCodexDesktop;
  desktopAuthorization?: typeof authorizeRemoteDesktop;
}

export async function runServiceCommand(options: CliOptions, context: ServiceCommandContext): Promise<void> {
  const platform = context.platform ?? process.platform;
  const log = context.log ?? console.log;
  const stdoutIsTTY = context.isTTY ?? process.stdout.isTTY === true;
  const logAccessUrl = async (accessUrl: string): Promise<void> => {
    log(`Open: ${accessUrl}`);
    if (!options.qr || !stdoutIsTTY) return;
    log("");
    log(await renderQr(accessUrl));
  };
  const controller = context.controller ?? context.launchAgent ?? createController(platform, context.homeDir);

  switch (options.serviceAction) {
    case "install": {
      const nodeVersion = context.nodeVersion ?? process.versions.node;
      assertSupportedNodeVersion(nodeVersion);
      const now = context.now?.() ?? new Date();
      const environment = context.environment ?? process.env;
      const environmentPath = buildServiceEnvironmentPath(
        context.nodePath,
        environment.PATH ?? environment.Path,
        platform,
      );
      let codexPath: string | undefined;
      try {
        const codex = await withCliProgress("正在检查和安装 Codex 组件", () => (context.codexResolver ?? resolveCodexRuntime)({
          dataDir: options.dataDir,
          target: detectPlatform(platform, context.arch ?? process.arch, nodeVersion),
          environment: { ...environment, PATH: environmentPath },
          platform,
          nodeExecutable: context.nodePath,
          onProgress: (message) => log(`… ${message}`),
        }));
        codexPath = codex.executable;
      } catch (error) {
        log(`⚠ Codex runtime was not pinned during service install: ${error instanceof Error ? error.message : error}`);
      }
      const config: ServiceConfig = {
        version: context.version,
        nodePath: context.nodePath,
        cliPath: context.cliPath,
        environmentPath,
        ...(codexPath ? { codexPath } : {}),
        ...(environment.CODEX_HOME?.trim() ? { codexHome: resolve(environment.CODEX_HOME.trim()) } : {}),
        roots: options.roots,
        port: options.port,
        relay: options.relay,
        tunnelCommand: options.tunnelCommand,
        localOnly: options.localOnly,
        dataDir: options.dataDir,
        installedAt: now.toISOString(),
      };
      const { definition, state } = await withCliProgress("正在安装后台服务，等待服务和手机访问连接就绪", () => controller.install(config));
      log(`✓ AgentRoam service installed: ${definition}`);
      if (state?.localUrl && state.status !== "stopped") printLocalDesktopUrl(state.localUrl, log, platform);
      requireReadyService(state);
      if (state?.localUrl && state.status !== "stopped" && (platform === "darwin" || platform === "win32")) {
        if (environment.AGENTROAM_INSTALL_REMOTE_DESKTOP === "skip") {
          log("已跳过安装时远程桌面授权，可稍后执行 agentroam desktop authorize。");
        } else {
          try {
            await (context.desktopAuthorization ?? authorizeRemoteDesktop)(options.dataDir, { platform, isTTY: stdoutIsTTY, log });
          } catch (error) {
            log(`远程桌面授权未完成：${error instanceof Error ? error.message : error}`);
            log("AgentRoam 安装继续；可稍后执行 agentroam desktop authorize，或在本机浏览器的“远程授权”面板中重试。");
          }
        }
      }
      if (platform === "darwin" && !options.desktopSetup) log("官方 Codex 桌面共享后端：agentroam codex-desktop --setup；预演：agentroam codex-desktop --dry-run。");
      if (state.version === config.version) await cleanupOldLaunchers(config, log);
      if (options.desktopSetup && platform === "darwin") {
        await withCliProgress("正在配置官方 Codex 桌面共享连接", () => (context.desktopSetup ?? setupCodexDesktop)(options, { platform, environment, service: config, log }));
      }
      log(`Open: ${state.accessUrl}`);
      await (context.pairingPrinter ?? printPairingCode)(options.dataDir, log, { accessUrl: state.accessUrl, qr: options.qr, interactive: stdoutIsTTY });
      return;
    }
    case "start": {
      const state = await withCliProgress("正在启动后台服务，等待服务和手机访问连接就绪", () => controller.start());
      if (state?.localUrl && state.status !== "stopped") printLocalDesktopUrl(state.localUrl, log, platform);
      requireReadyService(state);
      log("✓ AgentRoam service started");
      await logAccessUrl(state.accessUrl);
      return;
    }
    case "stop":
      await withCliProgress("正在停止后台服务", () => controller.stop());
      log("✓ AgentRoam service stopped");
      return;
    case "status": {
      const status = await controller.status();
      if (!status.installed) {
        log("AgentRoam service: not installed");
        return;
      }
      log(`AgentRoam service: ${status.running ? "running" : "installed but stopped"}`);
      if (status.config) {
        log(`Version: ${status.config.version}`);
        log(`Root: ${status.config.roots.join(", ")}`);
      }
      if (status.running && status.state?.localUrl) printLocalDesktopUrl(status.state.localUrl, log, platform);
      if (status.running && status.state?.status === "ready" && status.state.accessUrl) {
        await logAccessUrl(status.state.accessUrl);
      }
      return;
    }
    case "url":
      log(await controller.url());
      return;
    case "logs": {
      const logs = await controller.logs();
      log(`stdout: ${logs.stdoutPath}`);
      if (logs.stdout) log(logs.stdout.trimEnd());
      log(`stderr: ${logs.stderrPath}`);
      if (logs.stderr) log(logs.stderr.trimEnd());
      return;
    }
    case "restart": {
      const state = await withCliProgress("正在重启后台服务，等待服务和手机访问连接就绪", () => controller.restart());
      if (state?.localUrl && state.status !== "stopped") printLocalDesktopUrl(state.localUrl, log, platform);
      requireReadyService(state);
      log("✓ AgentRoam service restarted");
      await logAccessUrl(state.accessUrl);
      return;
    }
    case "uninstall": {
      const result = await controller.uninstall();
      log(result.removed ? "✓ AgentRoam service uninstalled" : "AgentRoam service was not installed");
      log(`Application data preserved: ${result.preservedDataDir}`);
      return;
    }
    default:
      throw cliError("service action is required");
  }
}

function requireReadyService(state: ServiceRuntimeState | null): asserts state is ServiceRuntimeState & { accessUrl: string } {
  if (state?.status !== "ready" || !state.accessUrl) {
    throw Object.assign(new Error(`AgentRoam 后台服务未就绪（${state?.status ?? "未取得状态"}）。请运行 agentroam service logs 查看原因，修复后运行 agentroam service start，再执行 agentroam pair。`), { exitCode: 1 });
  }
}

export function buildServiceEnvironmentPath(
  nodePath: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform,
): string {
  const separator = platform === "win32" ? ";" : delimiter;
  const nodeDirectory = platform === "win32" ? win32.dirname(nodePath) : dirname(nodePath);
  const absolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  const required = platform === "darwin" ? ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] : [];
  const entries = [nodeDirectory, ...(pathValue ?? "").split(separator), ...required]
    .map((entry) => entry.trim())
    .filter((entry) => entry && absolute(entry));
  return [...new Set(entries)].join(separator);
}

function createController(platform: NodeJS.Platform, homeDir?: string): ServiceController {
  if (platform === "darwin") return new MacLaunchAgent({ homeDir });
  if (platform === "win32") return new WindowsTaskService({ homeDir });
  throw cliError(`agentroam service is unavailable on ${platform}; supported platforms are macOS and Windows`);
}

function cliError(message: string): Error {
  return Object.assign(new Error(message), { exitCode: 2 });
}

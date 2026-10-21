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
import { configureCodexSharing } from "../codex-sharing.js";
import { setupCodexDesktop } from "../codex-desktop-setup.js";
import { authorizeRemoteDesktop } from "../desktop-authorization.js";
import { withCliProgress } from "../../bin/cli-progress.mjs";
import { withTimeout } from "../abort.js";

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
  configureSharing?: typeof configureCodexSharing;
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
        const codex = await withCliProgress("Checking Codex; the background service installs it if missing", () => withTimeout(signal => (context.codexResolver ?? resolveCodexRuntime)({
          dataDir: options.dataDir,
          target: detectPlatform(platform, context.arch ?? process.arch, nodeVersion),
          environment: { ...environment, PATH: environmentPath },
          platform,
          nodeExecutable: context.nodePath,
          installIfMissing: false,
          signal,
          onProgress: (message) => log(`… ${message}`),
        }), 60_000, "Codex check timed out; the background service will continue checking."));
        codexPath = codex.executable;
      } catch (error) {
        log(`Codex will be checked and installed during service startup: ${error instanceof Error ? error.message : error}`);
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
      if (platform === "darwin" && codexPath) {
        try {
          await withTimeout(signal => (context.configureSharing ?? configureCodexSharing)(options, {
            homeDir: context.homeDir, environment: { ...environment, PATH: environmentPath, AGENT_CODEX_BIN: codexPath }, signal,
          }), 10_000, "Codex sharing setup timed out (10 seconds)");
        }
        catch (error) { log(`Codex sharing setup incomplete; repair it from the computer menu: ${error instanceof Error ? error.message : error}`); }
      }
      const { definition, state } = await withCliProgress("Starting service; Codex: up to 180s, Cloudflare: up to 30s, then LAN fallback", () => controller.install(config));
      log(`✓ AgentRoam service installed: ${definition}`);
      if (state?.status !== "ready" && state?.localUrl) printLocalDesktopUrl(state.localUrl, log, platform);
      requireReadyService(state);
      log(`Open: ${state.accessUrl}`);
      if (state.localUrl) printLocalDesktopUrl(state.localUrl, log, platform);
      printLanFallback(state, log);
      if (state?.localUrl && state.status !== "stopped" && (platform === "darwin" || platform === "win32")) {
        if (environment.AGENTROAM_INSTALL_REMOTE_DESKTOP === "skip") {
          log("Remote desktop authorization skipped. Run agentroam desktop authorize later.");
        } else {
          try {
            await (context.desktopAuthorization ?? authorizeRemoteDesktop)(options.dataDir, { platform, isTTY: stdoutIsTTY, timeoutMs: 60_000, log });
          } catch (error) {
            log(`Remote desktop authorization incomplete: ${error instanceof Error ? error.message : error}`);
            log("Installation continues. Retry with agentroam desktop authorize or the local browser authorization panel.");
          }
        }
      }
      if (platform === "darwin" && !options.desktopSetup) log("Codex Desktop sharing: agentroam codex-desktop --setup; preview: agentroam codex-desktop --dry-run.");
      if (state.version === config.version) await cleanupOldLaunchers(config, log);
      if (options.desktopSetup && platform === "darwin") {
        await withCliProgress("Configuring Codex Desktop sharing", () => (context.desktopSetup ?? setupCodexDesktop)(options, { platform, environment, service: config, log }));
      }
      await (context.pairingPrinter ?? printPairingCode)(options.dataDir, log, { accessUrl: state.accessUrl, qr: options.qr, interactive: stdoutIsTTY });
      return;
    }
    case "start": {
      const state = await withCliProgress("Starting service; Codex: up to 180s, Cloudflare: up to 30s, then LAN fallback", () => controller.start());
      if (state?.status !== "ready" && state?.localUrl) printLocalDesktopUrl(state.localUrl, log, platform);
      requireReadyService(state);
      log(`Open: ${state.accessUrl}`);
      if (state.localUrl) printLocalDesktopUrl(state.localUrl, log, platform);
      printLanFallback(state, log);
      log("✓ AgentRoam service started");
      if (options.qr && stdoutIsTTY) log(await renderQr(state.accessUrl));
      return;
    }
    case "stop":
      await withCliProgress("Stopping background service", () => controller.stop());
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
      if (status.running && status.state?.status !== "ready" && status.state?.localUrl) printLocalDesktopUrl(status.state.localUrl, log, platform);
      if (status.running && status.state?.status === "ready" && status.state.accessUrl) {
        printLanFallback(status.state, log);
        await logAccessUrl(status.state.accessUrl);
        if (status.state.localUrl) printLocalDesktopUrl(status.state.localUrl, log, platform);
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
      const state = await withCliProgress("Restarting service; Codex: up to 180s, Cloudflare: up to 30s, then LAN fallback", () => controller.restart());
      if (state?.status !== "ready" && state?.localUrl) printLocalDesktopUrl(state.localUrl, log, platform);
      requireReadyService(state);
      log(`Open: ${state.accessUrl}`);
      if (state.localUrl) printLocalDesktopUrl(state.localUrl, log, platform);
      printLanFallback(state, log);
      log("✓ AgentRoam service restarted");
      if (options.qr && stdoutIsTTY) log(await renderQr(state.accessUrl));
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

function printLanFallback(state: ServiceRuntimeState, log: (line: string) => void): void {
  if (state.provider !== "lan") return;
  if (state.accessUrl && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(state.accessUrl).hostname)) {
    log("✓ Local access only. Connect to Wi-Fi or Ethernet and restart to enable phone access.");
    return;
  }
  log("✓ Service ready on LAN. Connect your phone to the same network to pair.");
}

function requireReadyService(state: ServiceRuntimeState | null): asserts state is ServiceRuntimeState & { accessUrl: string } {
  if (state?.status !== "ready" || !state.accessUrl) {
    throw Object.assign(new Error(`AgentRoam service is not ready (${state?.status ?? "no state"}). Run agentroam service logs, fix the error, then run agentroam service start and agentroam pair.`), { exitCode: 1 });
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

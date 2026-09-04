import type { CliOptions } from "../args.js";
import { MacLaunchAgent } from "./macos-launch-agent.js";
import type { ServiceConfig } from "./service-files.js";
import type { ServiceController } from "./service-controller.js";
import { WindowsTaskService } from "./windows-task-service.js";

interface ServiceCommandContext {
  platform?: NodeJS.Platform;
  homeDir?: string;
  nodePath: string;
  cliPath: string;
  version: string;
  nodeVersion?: string;
  now?: () => Date;
  log?: (line: string) => void;
  controller?: ServiceController;
  launchAgent?: MacLaunchAgent;
}

export async function runServiceCommand(options: CliOptions, context: ServiceCommandContext): Promise<void> {
  const platform = context.platform ?? process.platform;
  const log = context.log ?? console.log;
  const controller = context.controller ?? context.launchAgent ?? createController(platform, context.homeDir);

  switch (options.serviceAction) {
    case "install": {
      const nodeVersion = context.nodeVersion ?? process.versions.node;
      if (Number(nodeVersion.split(".")[0]) !== 22) {
        throw cliError(`Node.js 22 is required to install the service (current ${nodeVersion})`);
      }
      const now = context.now?.() ?? new Date();
      const config: ServiceConfig = {
        version: context.version,
        nodePath: context.nodePath,
        cliPath: context.cliPath,
        roots: options.roots,
        port: options.port,
        relay: options.relay,
        tunnelCommand: options.tunnelCommand,
        localOnly: options.localOnly,
        dataDir: options.dataDir,
        installedAt: now.toISOString(),
      };
      const { definition, state } = await controller.install(config);
      log(`✓ AgentRoam service installed: ${definition}`);
      if (state?.status === "ready" && state.accessUrl) log(`Open: ${state.accessUrl}`);
      else log("Service is starting. Run `agentroam service url` shortly.");
      return;
    }
    case "start": {
      const state = await controller.start();
      log("✓ AgentRoam service started");
      if (state?.status === "ready" && state.accessUrl) log(`Open: ${state.accessUrl}`);
      return;
    }
    case "stop":
      await controller.stop();
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
      if (status.running && status.state?.status === "ready" && status.state.accessUrl) {
        log(`Open: ${status.state.accessUrl}`);
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
      const state = await controller.restart();
      log("✓ AgentRoam service restarted");
      if (state?.status === "ready" && state.accessUrl) log(`Open: ${state.accessUrl}`);
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

function createController(platform: NodeJS.Platform, homeDir?: string): ServiceController {
  if (platform === "darwin") return new MacLaunchAgent({ homeDir });
  if (platform === "win32") return new WindowsTaskService({ homeDir });
  throw cliError(`agentroam service is unavailable on ${platform}; supported platforms are macOS and Windows`);
}

function cliError(message: string): Error {
  return Object.assign(new Error(message), { exitCode: 2 });
}

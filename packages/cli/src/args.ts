import { homedir } from "node:os";
import { resolve } from "node:path";

export type RelayMode = "auto" | "cloudflare" | "pinggy" | "custom";
export type CliCommand = "start" | "doctor" | "version" | "service";
export type ServiceAction = "install" | "status" | "url" | "logs" | "restart" | "uninstall";

export interface CliOptions {
  command: CliCommand;
  serviceAction: ServiceAction | null;
  roots: string[];
  port: number | null;
  relay: RelayMode;
  tunnelCommand: string | null;
  localOnly: boolean;
  qr: boolean;
  dataDir: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const values = [...argv];
  let command: CliOptions["command"] = "start";
  if (values[0] && ["start", "doctor", "version", "service"].includes(values[0])) {
    command = values.shift() as CliOptions["command"];
  }
  let serviceAction: ServiceAction | null = null;
  if (command === "service") {
    const action = values.shift();
    if (!action || !(["install", "status", "url", "logs", "restart", "uninstall"] as string[]).includes(action)) {
      throw cliError("service requires install, status, url, logs, restart, or uninstall");
    }
    serviceAction = action as ServiceAction;
    if (serviceAction !== "install" && values.length > 0) {
      throw cliError(`service ${serviceAction} does not accept options`);
    }
  }
  const options: CliOptions = {
    command,
    serviceAction,
    roots: [],
    port: null,
    relay: "auto",
    tunnelCommand: null,
    localOnly: false,
    qr: true,
    dataDir: resolve(homedir(), ".agentroam"),
  };

  for (let index = 0; index < values.length; index++) {
    const arg = values[index];
    const next = () => {
      const value = values[++index];
      if (!value) throw cliError(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--root") options.roots.push(resolve(next()));
    else if (arg === "--port") {
      const port = Number(next());
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw cliError("port must be 1-65535");
      options.port = port;
    } else if (arg === "--relay") {
      const relay = next();
      if (!(["auto", "cloudflare", "pinggy", "custom"] as string[]).includes(relay)) {
        throw cliError("relay must be auto, cloudflare, pinggy, or custom");
      }
      options.relay = relay as RelayMode;
    } else if (arg === "--tunnel-command") options.tunnelCommand = next();
    else if (arg === "--data-dir") options.dataDir = resolve(next());
    else if (arg === "--local-only") options.localOnly = true;
    else if (arg === "--no-qr") options.qr = false;
    else if (arg === "--help" || arg === "-h") throw Object.assign(new Error("help"), { exitCode: 0 });
    else throw cliError(`unknown argument: ${arg}`);
  }

  if (!options.roots.length) options.roots = [process.cwd()];
  if (options.relay === "custom" && !options.tunnelCommand) throw cliError("--relay custom requires --tunnel-command");
  return options;
}

function cliError(message: string): Error {
  return Object.assign(new Error(message), { exitCode: 2 });
}

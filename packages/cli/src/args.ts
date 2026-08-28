import { homedir } from "node:os";
import { resolve } from "node:path";

export type RelayMode = "auto" | "cloudflare" | "pinggy" | "custom";

export interface CliOptions {
  command: "start" | "doctor" | "version";
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
  if (values[0] && ["start", "doctor", "version"].includes(values[0])) command = values.shift() as CliOptions["command"];
  const options: CliOptions = {
    command,
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

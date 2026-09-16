import { homedir } from "node:os";
import { resolve } from "node:path";

export type RelayMode = "auto" | "cloudflare" | "pinggy" | "custom";
export type CliCommand = "start" | "doctor" | "version" | "service" | "unlock-service" | "update" | "update-worker" | "pair" | "devices" | "revoke" | "approvals" | "approve" | "deny" | "lock" | "unlock" | "audit";
export type ServiceAction = "install" | "start" | "stop" | "status" | "url" | "logs" | "restart" | "uninstall";
export type UnlockServiceAction = "install" | "uninstall" | "status";

export interface CliOptions {
  command: CliCommand;
  serviceAction: ServiceAction | null;
  unlockServiceAction: UnlockServiceAction | null;
  roots: string[];
  port: number | null;
  relay: RelayMode;
  tunnelCommand: string | null;
  localOnly: boolean;
  testNoPairing?: boolean;
  qr: boolean;
  dataDir: string;
  revokeDeviceId?: string | null;
  revokeAll?: boolean;
  approvalRequestId?: string;
  approvalPhrase?: string;
  pairingUrl?: string;
  updateVersion?: string | null;
  updateStateFile?: string | null;
}

export function parseArgs(argv: string[]): CliOptions {
  const values = [...argv];
  let command: CliOptions["command"] = "start";
  if (values[0] && ["start", "doctor", "version", "service", "unlock-service", "update", "update-worker", "pair", "devices", "revoke", "approvals", "approve", "deny", "lock", "unlock", "audit"].includes(values[0])) {
    command = values.shift() as CliOptions["command"];
  }
  let serviceAction: ServiceAction | null = null;
  let unlockServiceAction: UnlockServiceAction | null = null;
  if (command === "service") {
    const action = values.shift();
    if (!action || !(["install", "start", "stop", "status", "url", "logs", "restart", "uninstall"] as string[]).includes(action)) {
      throw cliError("service requires install, start, stop, status, url, logs, restart, or uninstall");
    }
    serviceAction = action as ServiceAction;
    if (serviceAction !== "install" && values.length > 0) {
      throw cliError(`service ${serviceAction} does not accept options`);
    }
  }
  if (command === "unlock-service") {
    const action = values.shift();
    if (!action || !(["install", "uninstall", "status"] as string[]).includes(action) || values.length > 0) {
      throw cliError("unlock-service requires install, uninstall, or status and accepts no options");
    }
    unlockServiceAction = action as UnlockServiceAction;
  }
  let revokeDeviceId: string | null = null;
  let revokeAll = false;
  if (command === "revoke") {
    const device = values.shift();
    if (device === "--all") revokeAll = true;
    else if (device && /^[a-f0-9-]{36}$/.test(device)) revokeDeviceId = device;
    else throw cliError("revoke requires a device ID or --all");
  }
  let approvalRequestId: string | undefined;
  if (command === "approve" || command === "deny") {
    approvalRequestId = values.shift();
    if (!approvalRequestId || !/^[a-f0-9-]{36}$/.test(approvalRequestId)) throw cliError(`${command} requires a request ID`);
  }
  let updateVersion: string | null = null;
  let updateStateFile: string | null = null;
  if (command === "update" && values[0] && !values[0].startsWith("--")) updateVersion = values.shift()!;
  if (command === "update-worker") {
    const stateFile = values.shift();
    if (!stateFile || values.length > 0) throw cliError("update-worker requires one state file");
    updateStateFile = resolve(stateFile);
  }
  const options: CliOptions = {
    command,
    serviceAction,
    unlockServiceAction,
    roots: [],
    port: null,
    relay: "auto",
    tunnelCommand: null,
    localOnly: false,
    qr: true,
    dataDir: resolve(homedir(), ".agentroam"),
    ...(command === "revoke" ? { revokeDeviceId, revokeAll } : {}),
    ...(approvalRequestId ? { approvalRequestId } : {}),
    updateVersion,
    updateStateFile,
  };

  for (let index = 0; index < values.length && command !== "update-worker"; index++) {
    const arg = values[index];
    const next = () => {
      const value = values[++index];
      if (!value) throw cliError(`missing value for ${arg}`);
      return value;
    };
    if (arg === "--url" && command === "pair") options.pairingUrl = next();
    else if (arg === "--root") options.roots.push(resolve(next()));
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
    else if (arg === "--phrase" && command === "approve") options.approvalPhrase = next();
    else if (arg === "--local-only") options.localOnly = true;
    else if (arg === "--test-no-pairing") options.testNoPairing = true;
    else if (arg === "--no-qr") options.qr = false;
    else if (arg === "--help" || arg === "-h") throw Object.assign(new Error("help"), { exitCode: 0 });
    else throw cliError(`unknown argument: ${arg}`);
  }

  if (command === "approve" && !options.approvalPhrase) throw cliError("approve requires --phrase matching the phone");

  if (command === "update" && updateVersion && !/^\d+\.\d+\.\d+$/.test(updateVersion)) {
    throw cliError("update version must be an exact stable X.Y.Z version");
  }

  if (options.testNoPairing && (command !== "start" || !options.localOnly || options.tunnelCommand || options.relay !== "auto")) throw cliError("--test-no-pairing requires start --local-only and cannot use a tunnel or background service");

  if (!options.roots.length) options.roots = [process.cwd()];
  if (options.relay === "custom" && !options.tunnelCommand) throw cliError("--relay custom requires --tunnel-command");
  return options;
}

function cliError(message: string): Error {
  return Object.assign(new Error(message), { exitCode: 2 });
}

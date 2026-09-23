import { homedir } from "node:os";
import { join } from "node:path";
import type { ComputerAction } from "../domain/computer-action.js";
import type { ComputerErrorCode, ComputerObservation } from "../domain/computer-observation.js";
import type { ComputerRuntimeStatus } from "../ports/computer-runtime-port.js";

export const COMPUTER_RELAY_PROTOCOL_VERSION = 1;
export const COMPUTER_RELAY_SOCKET_NAME = "computer-relay.sock";
export const COMPUTER_RELAY_REQUEST_LIMIT = 128 * 1024;
export const COMPUTER_RELAY_RESPONSE_LIMIT = 6 * 1024 * 1024;
export const COMPUTER_RELAY_TIMEOUT_MS = 8_000;

export type ComputerRelayRequest =
  | { id: string; version: number; type: "status" }
  | { id: string; version: number; type: "execute"; action: ComputerAction };

export type ComputerRelayResponse =
  | { id: string; ok: true; result: ComputerRuntimeStatus | ComputerObservation }
  | { id: string; ok: false; error: { code: ComputerErrorCode; message: string; recovery?: string } };

export function resolveComputerRelayDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_NATIVE_RUNTIME_DIR?.trim() || join(homedir(), ".agentroam", "native-runtime");
}

export function resolveComputerRelaySocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveComputerRelayDirectory(env), COMPUTER_RELAY_SOCKET_NAME);
}

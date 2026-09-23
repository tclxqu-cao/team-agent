import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { computerActionSchema, type ComputerAction } from "../domain/computer-action.js";
import { ComputerOperationError, isComputerErrorCode, type ComputerObservation } from "../domain/computer-observation.js";
import type { ComputerRuntimePort, ComputerRuntimeStatus } from "../ports/computer-runtime-port.js";
import {
  COMPUTER_RELAY_PROTOCOL_VERSION,
  COMPUTER_RELAY_REQUEST_LIMIT,
  COMPUTER_RELAY_RESPONSE_LIMIT,
  COMPUTER_RELAY_TIMEOUT_MS,
  resolveComputerRelaySocketPath,
  type ComputerRelayResponse,
} from "./relay-protocol.js";

type ConnectSocket = (path: string) => Socket;

export class ComputerRelayClient implements ComputerRuntimePort {
  constructor(private readonly options: {
    socketPath?: string;
    timeoutMs?: number;
    connect?: ConnectSocket;
    exists?: (path: string) => boolean;
  } = {}) {}

  async status(signal?: AbortSignal): Promise<ComputerRuntimeStatus> {
    try {
      return await this.request<ComputerRuntimeStatus>({ type: "status" }, signal);
    } catch (error) {
      if (error instanceof ComputerOperationError && error.code === "desktop_offline") {
        return { available: false };
      }
      throw error;
    }
  }

  execute(action: ComputerAction, signal?: AbortSignal): Promise<ComputerObservation> {
    const parsed = computerActionSchema.safeParse(action);
    if (!parsed.success) throw new ComputerOperationError("invalid_request", parsed.error.message);
    return this.request<ComputerObservation>({ type: "execute", action: parsed.data }, signal);
  }

  private request<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const socketPath = this.options.socketPath ?? resolveComputerRelaySocketPath();
    const exists = this.options.exists ?? existsSync;
    if (!exists(socketPath)) {
      return Promise.reject(new ComputerOperationError("desktop_offline", "AgentRoam desktop is offline"));
    }
    if (signal?.aborted) return Promise.reject(new ComputerOperationError("aborted", "Computer request was aborted"));

    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
    const line = `${JSON.stringify({ id, version: COMPUTER_RELAY_PROTOCOL_VERSION, ...payload })}\n`;
    if (Buffer.byteLength(line) > COMPUTER_RELAY_REQUEST_LIMIT) {
      return Promise.reject(new ComputerOperationError("invalid_request", "Computer relay request exceeds 128 KiB"));
    }

    return new Promise<T>((resolve, reject) => {
      const connect = this.options.connect ?? createConnection;
      let socket: Socket;
      try {
        socket = connect(socketPath);
      } catch (error) {
        reject(new ComputerOperationError("desktop_offline", error instanceof Error ? error.message : String(error)));
        return;
      }
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(result as T);
      };
      const timer = setTimeout(() => finish(new ComputerOperationError("action_timeout", "Computer relay request timed out")), this.options.timeoutMs ?? COMPUTER_RELAY_TIMEOUT_MS);
      const onAbort = () => finish(new ComputerOperationError("aborted", "Computer request was aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(line));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > COMPUTER_RELAY_RESPONSE_LIMIT) {
          finish(new ComputerOperationError("protocol_error", "Computer relay response exceeds 6 MiB"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        let message: ComputerRelayResponse;
        try {
          message = JSON.parse(buffer.slice(0, newline)) as ComputerRelayResponse;
        } catch {
          finish(new ComputerOperationError("protocol_error", "Invalid computer relay response"));
          return;
        }
        if (message.id !== id) return;
        if (message.ok) finish(undefined, message.result as T);
        else finish(new ComputerOperationError(
          isComputerErrorCode(message.error.code) ? message.error.code : "protocol_error",
          message.error.message || "Computer relay error",
          message.error.recovery,
        ));
      });
      socket.on("error", (error: NodeJS.ErrnoException) => finish(new ComputerOperationError(
        error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "desktop_offline" : "protocol_error",
        error.message,
      )));
    });
  }
}

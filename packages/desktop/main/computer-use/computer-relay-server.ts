import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  COMPUTER_RELAY_PROTOCOL_VERSION,
  COMPUTER_RELAY_REQUEST_LIMIT,
  COMPUTER_RELAY_RESPONSE_LIMIT,
  ComputerOperationError,
  computerActionSchema,
  isComputerErrorCode,
  resolveComputerRelaySocketPath,
  type ComputerRelayResponse,
  type ComputerRuntimePort,
} from "@agent/computer-use";

export interface ComputerRelayServerOptions {
  runtime: ComputerRuntimePort;
  socketPath?: string;
}

function failure(error: unknown): { code: "protocol_error" | ReturnType<typeof errorCode>; message: string; recovery?: string } {
  if (error instanceof ComputerOperationError) {
    return { code: error.code, message: error.message, ...(error.recovery ? { recovery: error.recovery } : {}) };
  }
  return { code: "protocol_error", message: error instanceof Error ? error.message : String(error) };
}

function errorCode(value: unknown) {
  return isComputerErrorCode(value) ? value : "protocol_error" as const;
}

export class ComputerRelayServer {
  readonly socketPath: string;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly options: ComputerRelayServerOptions) {
    this.socketPath = options.socketPath ?? resolveComputerRelaySocketPath();
  }

  async start(): Promise<void> {
    if (this.server) return;
    const directory = dirname(this.socketPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });

    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    }).catch((error) => {
      this.server = null;
      throw error;
    });
    await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("close", () => this.sockets.delete(socket));
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > COMPUTER_RELAY_REQUEST_LIMIT) {
        handled = true;
        this.write(socket, {
          id: "unknown",
          ok: false,
          error: { code: "invalid_request", message: "Computer relay request exceeds 128 KiB" },
        });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const controller = new AbortController();
      socket.once("close", () => controller.abort());
      void this.handleLine(buffer.slice(0, newline), controller.signal)
        .then((response) => this.write(socket, response))
        .catch((error) => this.write(socket, {
          id: "unknown",
          ok: false,
          error: failure(error),
        }));
    });
  }

  private async handleLine(line: string, signal: AbortSignal): Promise<ComputerRelayResponse> {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { id: "unknown", ok: false, error: { code: "invalid_request", message: "Invalid computer relay JSON" } };
    }
    const id = typeof request.id === "string" && request.id.length <= 200 ? request.id : "unknown";
    try {
      if (id === "unknown") throw new ComputerOperationError("invalid_request", "Computer relay request ID is missing or invalid");
      if (request.version !== COMPUTER_RELAY_PROTOCOL_VERSION) {
        throw new ComputerOperationError("protocol_error", `Unsupported computer relay protocol version: ${String(request.version)}`);
      }
      if (request.type === "status") {
        return { id, ok: true, result: await this.options.runtime.status(signal) };
      }
      if (request.type === "execute") {
        const parsed = computerActionSchema.safeParse(request.action);
        if (!parsed.success) throw new ComputerOperationError("invalid_request", parsed.error.message);
        return { id, ok: true, result: await this.options.runtime.execute(parsed.data, signal) };
      }
      throw new ComputerOperationError("invalid_request", `Unsupported computer relay request type: ${String(request.type)}`);
    } catch (error) {
      return { id, ok: false, error: failure(error) };
    }
  }

  private write(socket: Socket, response: ComputerRelayResponse): void {
    let line = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(line) > COMPUTER_RELAY_RESPONSE_LIMIT) {
      line = `${JSON.stringify({
        id: response.id,
        ok: false,
        error: { code: "protocol_error", message: "Computer relay response exceeds 6 MiB" },
      })}\n`;
    }
    socket.end(line);
  }
}

import WebSocket from "ws";
import { createConnection } from "node:net";
import type { AhpTransport, TransportFrame } from "@microsoft/agent-host-protocol/client";
import { AsyncEventQueue } from "./async-event-queue.js";
import type { VSCodeAgentEndpoint } from "./copilot-vscode-discovery.js";

/** AHP's standard WS transport cannot address Unix sockets / Windows named pipes. */
export class VSCodeSocketTransport implements AhpTransport {
  private readonly frames = new AsyncEventQueue<TransportFrame>();
  private readonly iterator = this.frames[Symbol.asyncIterator]();
  private failed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data, binary) => {
      if (binary) { this.failed = true; socket.close(); return; }
      this.frames.push({ kind: "text", text: data.toString() });
    });
    socket.on("error", () => { this.failed = true; this.frames.close(); });
    socket.on("close", () => this.frames.close());
  }

  static async open(endpoint: VSCodeAgentEndpoint): Promise<VSCodeSocketTransport> {
    // The secret-bearing URL is deliberately never included in diagnostics.
    const socket = new WebSocket(`ws://localhost/?tkn=${encodeURIComponent(endpoint.connectionToken)}`,
      { createConnection: () => createConnection(endpoint.endpoint.path), handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024 });
    const transport = new VSCodeSocketTransport(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new Error("无法连接 VS Code Agent Host，请确认 VS Code 正在运行")));
    });
    return transport;
  }

  send(message: Parameters<AhpTransport["send"]>[0]): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("VS Code Agent Host 连接已断开");
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  async recv(): Promise<TransportFrame | null> {
    const frame = await this.iterator.next();
    if (frame.done && this.failed) throw new Error("VS Code Agent Host 连接已断开");
    return frame.done ? null : frame.value;
  }

  close(): void { this.socket.terminate(); this.frames.close(); }
}

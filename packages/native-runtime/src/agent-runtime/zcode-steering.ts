import { createHash, randomUUID } from "node:crypto";
import { nativeRecord, type NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import { RuntimeSessionError } from "./types.js";

interface SteeringCommand {
  sessionId: string;
  input: string;
  envelope: NativeJsonPacket;
  attempted: boolean;
  accepted: boolean;
  attempt: number;
  rejected: boolean;
  flight?: Promise<boolean>;
}

/** Native admission transfers the input to ZCode's durable guide/queue owner. */
export class ZCodeSteering {
  private readonly commands = new Map<string, SteeringCommand>();

  constructor(private readonly rpc: NativeRpcConnection) {}

  steer(sessionId: string, input: string, messageId: string = randomUUID()): Promise<boolean> {
    const key = JSON.stringify([sessionId, messageId]);
    let command = this.commands.get(key);
    if (command && !command.rejected && command.input !== input) {
      return Promise.reject(new RuntimeSessionError("插入消息的内容已变更，请先确认原消息是否已被 ZCode 接收", "NATIVE_PROTOCOL_ERROR"));
    }
    if (!command || (command.rejected && !command.flight)) {
      const attempt = command ? command.attempt + 1 : 0;
      const baseId = `agentroam-guide:${createHash("sha256").update(key).digest("hex")}`;
      const commandId = attempt ? `${baseId}:retry:${attempt}` : baseId;
      command = { sessionId, input, attempted: false, accepted: false, rejected: false, attempt, envelope: {
        commandId, clientId: "agentroam", sessionId, type: "sendText",
        payload: { text: input, requestedDelivery: "guide" }, issuedAt: Date.now(),
      } };
      this.commands.set(key, command);
    }
    if (command.accepted) return Promise.resolve(true);
    if (command.flight) return command.flight;
    const current = command;
    const flight = this.submit(current).then(result => {
      current.accepted = result;
      return result;
    }).finally(() => { if (current.flight === flight) current.flight = undefined; });
    current.flight = flight;
    return flight;
  }

  private async query(command: SteeringCommand): Promise<NativeJsonPacket | undefined> {
    const result = await this.rpc.request("v4/commands/query", { commands: [{ sessionId: command.sessionId, commandId: command.envelope.commandId }] });
    const rows = Array.isArray(result.results) ? result.results.map(nativeRecord) : [];
    const row = rows.find(row => {
      const key = nativeRecord(row.key);
      return key.sessionId === command.sessionId && key.commandId === command.envelope.commandId;
    });
    return row && row.result !== "unknown" ? nativeRecord(row.result) : undefined;
  }

  private accepted(command: SteeringCommand, ack: NativeJsonPacket): boolean {
    const result = nativeRecord(ack.result);
    if (ack.commandId !== command.envelope.commandId) {
      throw new RuntimeSessionError("ZCode 插入回执的命令 ID 不匹配，消息仍保留在队列中", "NATIVE_PROTOCOL_ERROR");
    }
    if (ack.status !== "accepted" && ack.status !== "duplicate") {
      // Only a definitive native refusal permits a fresh command on the next user retry.
      command.rejected = ["rejected", "failed", "stale", "noop"].includes(String(ack.status));
      throw new RuntimeSessionError(`ZCode 未接收插入消息：${String(ack.message ?? ack.reasonCode ?? ack.status ?? "无有效回执")}`, "NATIVE_PROTOCOL_ERROR");
    }
    // ZCode currently reports delivery=queue even when an inline guide was admitted.
    if (result.type !== "inputAccepted" || result.inputId !== command.envelope.commandId
      || !["guide", "queue", "startNow"].includes(String(result.delivery))) {
      throw new RuntimeSessionError("ZCode 尚未确认插入消息的接收结果，消息仍保留在队列中", "NATIVE_PROTOCOL_ERROR");
    }
    return true;
  }

  private async submit(command: SteeringCommand): Promise<boolean> {
    if (command.attempted) {
      const previous = await this.query(command);
      if (previous) return this.accepted(command, previous);
    }
    command.attempted = true;
    let ack: NativeJsonPacket;
    try { ack = await this.rpc.request("v4/command", command.envelope); }
    catch (error) {
      // A lost ACK does not permit a new command identity or a legacy session/send.
      const recovered = await this.query(command).catch(() => undefined);
      if (recovered) return this.accepted(command, recovered);
      throw error;
    }
    if ((ack.status === "accepted" || ack.status === "duplicate") && !ack.result) {
      const recovered = await this.query(command).catch(() => undefined);
      if (recovered) return this.accepted(command, recovered);
    }
    return this.accepted(command, ack);
  }

  clearSession(sessionId: string): void {
    for (const [key, command] of this.commands) if (command.sessionId === sessionId) this.commands.delete(key);
  }
}

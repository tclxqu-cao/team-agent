import { describe, expect, it, vi } from "vitest";
import type { NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import { ZCodeSteering } from "./zcode-steering.js";

const accepted = (command: NativeJsonPacket, delivery = "queue") => ({
  commandId: command.commandId, status: "accepted", revisionAtDecision: 1,
  result: { type: "inputAccepted", inputId: command.commandId, delivery },
});
const connection = (request: NativeRpcConnection["request"]): NativeRpcConnection => ({
  request: vi.fn(request), notify: async () => {}, onNotification: () => () => {}, onRequest: () => {}, onFailure: () => () => {}, dispose: async () => {},
});
const queryResult = (params: NativeJsonPacket, result: unknown) => ({ results: [{ key: (params.commands as NativeJsonPacket[])[0], result }] });

describe("ZCode V4 guide admission", () => {
  it.each(["queue", "guide", "startNow"])("accepts a matching input receipt with native delivery=%s", async delivery => {
    const rpc = connection(async (method, params) => {
      expect(method).toBe("v4/command");
      expect(params).toMatchObject({ sessionId: "sess", type: "sendText", clientId: "agentroam", payload: { text: "补充要求", requestedDelivery: "guide" } });
      return accepted(params, delivery);
    });
    await expect(new ZCodeSteering(rpc).steer("sess", "补充要求", "queue-one")).resolves.toBe(true);
    expect(rpc.request).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight command and keeps the accepted receipt for repeated clicks", async () => {
    let finish!: (value: NativeJsonPacket) => void;
    let envelope!: NativeJsonPacket;
    const rpc = connection(async (_method, params) => {
      envelope = params;
      return new Promise(resolve => { finish = resolve; });
    });
    const guide = new ZCodeSteering(rpc);
    const first = guide.steer("sess", "one input", "queue-one");
    const second = guide.steer("sess", "one input", "queue-one");
    expect(second).toBe(first);
    expect(rpc.request).toHaveBeenCalledTimes(1);
    finish(accepted(envelope));
    await expect(first).resolves.toBe(true);
    await expect(guide.steer("sess", "one input", "queue-one")).resolves.toBe(true);
    expect(rpc.request).toHaveBeenCalledTimes(1);
  });

  it("uses session-scoped stable identities across client recreation", async () => {
    const rpc = connection(async (_method, params) => accepted(params));
    await new ZCodeSteering(rpc).steer("sess", "input", "queue-one");
    await new ZCodeSteering(rpc).steer("sess", "input", "queue-one");
    await new ZCodeSteering(rpc).steer("other", "input", "queue-one");
    const ids = vi.mocked(rpc.request).mock.calls.map(([, params]) => params.commandId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[2]);
  });

  it("reconciles a lost ACK against the exact native command without another send", async () => {
    let command!: NativeJsonPacket;
    const rpc = connection(async (method, params) => {
      if (method === "v4/command") { command = params; throw new Error("ACK timed out"); }
      expect(method).toBe("v4/commands/query");
      return queryResult(params, accepted(command));
    });
    await expect(new ZCodeSteering(rpc).steer("sess", "input", "queue-one")).resolves.toBe(true);
    expect(vi.mocked(rpc.request).mock.calls.map(([method]) => method)).toEqual(["v4/command", "v4/commands/query"]);
  });

  it("retains the original identity when an unknown send is retried", async () => {
    let attempts = 0;
    const rpc = connection(async (method, params) => {
      if (method === "v4/commands/query") return queryResult(params, "unknown");
      if (++attempts === 1) throw new Error("connection interrupted");
      return accepted(params);
    });
    const guide = new ZCodeSteering(rpc);
    await expect(guide.steer("sess", "input", "queue-one")).rejects.toThrow("connection interrupted");
    await expect(guide.steer("sess", "input", "queue-one")).resolves.toBe(true);
    const sends = vi.mocked(rpc.request).mock.calls.filter(([method]) => method === "v4/command");
    expect(sends).toHaveLength(2);
    expect(sends[1][1]).toEqual(sends[0][1]);
    expect(vi.mocked(rpc.request).mock.calls.some(([method]) => method === "session/send")).toBe(false);
  });

  it("resolves a duplicate ACK without a result through command query", async () => {
    let command!: NativeJsonPacket;
    const rpc = connection(async (method, params) => {
      if (method === "v4/command") { command = params; return { commandId: params.commandId, status: "duplicate" }; }
      return queryResult(params, accepted(command));
    });
    await expect(new ZCodeSteering(rpc).steer("sess", "input", "queue-one")).resolves.toBe(true);
  });

  it.each(["rejected", "failed", "stale", "noop"])("does not consume a broker message for a native %s ACK", async status => {
    const rpc = connection(async (_method, params) => ({ commandId: params.commandId, status, reasonCode: "guard.inputRejected" }));
    await expect(new ZCodeSteering(rpc).steer("sess", "input", "queue-one")).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
  });

  it("allows a fresh user retry only after a definitive refusal", async () => {
    let attempts = 0;
    const rpc = connection(async (_method, params) => ++attempts === 1
      ? { commandId: params.commandId, status: "rejected", reasonCode: "guard.inputRejected" }
      : accepted(params));
    const guide = new ZCodeSteering(rpc);
    await expect(guide.steer("sess", "input", "queue-one")).rejects.toThrow("guard.inputRejected");
    await expect(guide.steer("sess", "input", "queue-one")).resolves.toBe(true);
    const ids = vi.mocked(rpc.request).mock.calls.map(([, params]) => params.commandId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[1]).toBe(`${ids[0]}:retry:1`);
  });

  it.each(["commandId", "inputId", "type", "delivery"])("rejects a malformed %s receipt", async field => {
    const rpc = connection(async (_method, params) => {
      const ack = accepted(params);
      if (field === "commandId") ack.commandId = "different";
      else (ack.result as Record<string, unknown>)[field] = "different";
      return ack;
    });
    await expect(new ZCodeSteering(rpc).steer("sess", "input", "queue-one")).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
  });

  it("does not reuse an uncertain message identity for edited text", async () => {
    const rpc = connection(async method => {
      if (method === "v4/command") throw new Error("ACK lost");
      return { results: [] };
    });
    const guide = new ZCodeSteering(rpc);
    await expect(guide.steer("sess", "original", "queue-one")).rejects.toThrow("ACK lost");
    await expect(guide.steer("sess", "edited", "queue-one")).rejects.toThrow("内容已变更");
    expect(vi.mocked(rpc.request).mock.calls.filter(([method]) => method === "v4/command")).toHaveLength(1);
  });
});

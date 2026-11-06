import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@agent/core";
import { ZCodeClient, decodeZCodeHistory } from "./zcode-client.js";
import { ZCodeRuntimeAdapter } from "./zcode-runtime-adapter.js";
import type { NativeRpcConnection } from "./native-rpc-client.js";
import { NativeRpcError } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { RuntimeSessionError } from "./types.js";
import { encodeUnifiedSessionId } from "./session-id.js";
import { UnifiedSessionService } from "./unified-session-service.js";
import type { ZCodeImageAttachment } from "./zcode-image-attachments.js";

const imageTestDirectories: string[] = [];
afterEach(async () => { await Promise.all(imageTestDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const pngImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dPAAAAAASUVORK5CYII=";
const gifImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

async function imageClient(rpc = new ZCodeFixture()) {
  const directory = await mkdtemp(join(tmpdir(), "agentroam-zcode-images-"));
  imageTestDirectories.push(directory);
  return { rpc, directory, client: new ZCodeClient(rpc, { readMany: async () => new Map() }, undefined, directory) };
}

class ZCodeFixture implements NativeRpcConnection {
  calls: Array<{ method: string; params: NativeJsonPacket }> = [];
  listener: (method: string, params: NativeJsonPacket) => void = () => {};
  handler: (method: string, params: NativeJsonPacket) => Promise<unknown> = async () => ({});
  sequence = 10;
  prompt: () => Promise<void> = async () => {
    this.emit("model.streaming", { kind: "text_delta", delta: "native answer" });
    this.emit("turn.completed", {});
  };
  session = { sessionId: "sess_native", title: "Native ZCode", workspace: { workspacePath: "/native/zcode", workspaceKey: "/native/zcode" }, createdAt: 1792972800000, updatedAt: 1792972800000, status: "idle" };
  models: NativeJsonPacket[] = [{ ref: { providerId: "zcode-native", modelId: "native-model" }, label: "Native model", providerLabel: "Native provider" }];
  command: (params: NativeJsonPacket) => Promise<NativeJsonPacket> = async params => ({ commandId: params.commandId, status: "accepted", result: { type: "inputAccepted", inputId: params.commandId, delivery: "queue" } });
  async request(method: string, params: NativeJsonPacket): Promise<NativeJsonPacket> {
    this.calls.push({ method, params });
    if (method === "v4/command") return this.command(params);
    if (method === "session/list") return { sessions: [this.session] };
    if (method === "session/create" || method === "session/resume") {
      const preferences = await this.handler("session/requestRuntimePreferences", { sessionId: "sess_native", scope: "runtime-materialization" });
      expect(preferences).toMatchObject({ askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: "preflight-v1" });
      return this.snapshot();
    }
    if (method === "session/read") return { ...this.snapshot(), settings: { model: { available: [] } } };
    if (method === "session/messages") return { messages: [{ info: { id: "native-message", role: "user" }, parts: [{ type: "text", text: "native history" }] }] };
    if (method === "session/subscribe") return { eventSeq: this.sequence, events: [], sessionId: "sess_native" };
    if (method === "session/send") { void this.prompt(); return { accepted: true, sessionId: "sess_native" }; }
    return {};
  }
  snapshot() { return { session: this.session, settings: { model: { available: this.models } } }; }
  emit(type: string, payload: NativeJsonPacket) { this.listener("session/event", { sessionId: "sess_native", seq: ++this.sequence, type, payload, turnId: "native-turn" }); }
  async notify() {}
  onNotification(listener: typeof this.listener) { this.listener = listener; return () => {}; }
  onRequest(handler: typeof this.handler) { this.handler = handler; }
  onFailure(_listener: (error: RuntimeSessionError) => void) { return () => {}; }
  async dispose() {}
}
async function collect(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events; }

describe("ZCode catalog with empty resident sessions", () => {
  it("keeps empty residents, persisted sessions and their children when one parent is not persisted yet", async () => {
    const rpc = new ZCodeFixture();
    const persisted = { ...rpc.session, sessionId: "sess_saved" };
    const child = { ...rpc.session, sessionId: "sess_child", sessionKind: "subagent_child", parentSessionId: "sess_saved" };
    rpc.request = async (method, params) => {
      rpc.calls.push({ method, params });
      if (method === "session/list") return { sessions: params.sessionIds ? [child] : [rpc.session, persisted] };
      if (method === "session/subagents" && params.sessionId === "sess_native") {
        throw new NativeRpcError("Session not found: sess_native", -32004);
      }
      if (method === "session/subagents") return { childSessionIds: ["sess_child"] };
      throw new Error(`Unexpected method ${method}`);
    };
    const client = new ZCodeClient(rpc, { readMany: async () => new Map() });
    const sessions = await client.list();
    expect(sessions.map(session => session.id)).toEqual(["sess_native", "sess_saved", "sess_child"]);
    expect(sessions[2]).toMatchObject({ parentSessionId: "sess_saved", readOnly: true });
    expect(rpc.calls.some(call => /session\/(resume|send|stop)/.test(call.method))).toBe(false);
  });

  it("caches an empty child catalog and refreshes it when the parent changes after its first send", async () => {
    const rpc = new ZCodeFixture();
    const request = rpc.request.bind(rpc);
    let persisted = false;
    let childLookups = 0;
    rpc.request = async (method, params) => {
      if (method === "session/subagents") {
        childLookups++;
        if (!persisted) throw new NativeRpcError("Session not found: sess_native", -32004);
        return { childSessionIds: [] };
      }
      return request(method, params);
    };
    const client = new ZCodeClient(rpc, { readMany: async () => new Map() });
    await client.list();
    await client.list();
    expect(childLookups).toBe(1);
    persisted = true; rpc.session.updatedAt++;
    await client.list();
    expect(childLookups).toBe(2);
  });

  it.each([
    new NativeRpcError("Session runtime is not ready", -32004),
    new NativeRpcError("Session not found: other-session", -32004),
    new NativeRpcError("Session not found: sess_native", -32010),
    new Error("Session not found: sess_native"),
  ])("preserves unrelated subagent discovery failures: %s", async error => {
    const rpc = new ZCodeFixture();
    const request = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method === "session/subagents") throw error;
      return request(method, params);
    };
    const client = new ZCodeClient(rpc, { readMany: async () => new Map() });
    await expect(client.list()).rejects.toBe(error);
  });
});

describe("ZCode desktop running-state projection", () => {
  it("forwards external normal sends and durable guides without resuming a second resident", async () => {
    const rpc = new ZCodeFixture();
    const guide = {
      available: async () => true,
      read: async () => ({ ...rpc.snapshot(), session: { ...rpc.session, status: "running" }, messages: [{ info: { id: "desktop-row", role: "assistant" }, parts: [{ type: "text", text: "desktop output" }] }] }),
      steer: vi.fn(async () => true),
    };
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", true]]) }, guide);
    const adapter = new ZCodeRuntimeAdapter(client);
    const service = new UnifiedSessionService([adapter], async () => []);
    const sid = encodeUnifiedSessionId("zcode", "sess_native");
    const metadata = (await adapter.discoverSessions())[0];
    expect(metadata).toMatchObject({ occupancy: "owned-externally", canResume: false, externalGuideSupported: true, nativeModelSelectionSupported: false });
    expect((await adapter.getSession("sess_native")).messages).toContainEqual(expect.objectContaining({ content: "desktop output" }));
    const events = await collect(service.run(sid, "extra requirement", undefined, undefined, undefined, { brokerRunId: "broker-guide-id" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "runtime_progress", label: "已交给桌面端原会话" }));
    expect(guide.steer).toHaveBeenCalledWith(expect.objectContaining({ id: "sess_native" }), "extra requirement", "broker-guide-id");
    await expect(service.steer(sid, "more", "durable-message-id")).resolves.toBe(true);
    expect(guide.steer).toHaveBeenLastCalledWith(expect.objectContaining({ id: "sess_native" }), "more", "durable-message-id");
    expect(rpc.calls.some(call => /session\/(resume|send|subscribe|stop)/.test(call.method))).toBe(false);
  });

  it("keeps externally running children readonly even if a bridge is available", async () => {
    const rpc = new ZCodeFixture(); Object.assign(rpc.session, { sessionKind: "subagent_child" });
    const guide = { available: vi.fn(async () => true), steer: vi.fn(async () => true) };
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", true]]) }, guide);
    const adapter = new ZCodeRuntimeAdapter(client);
    expect((await adapter.discoverSessions())[0]).toMatchObject({ canResume: false, readOnly: true });
    await expect(collect(client.run("sess_native", "must not send"))).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    expect(guide.steer).not.toHaveBeenCalled();
    expect(guide.available).not.toHaveBeenCalled();
  });

  it("preserves an external guide failure without falling back to local send", async () => {
    const rpc = new ZCodeFixture();
    const guide = { available: async () => true, steer: async () => { throw new Error("owner went away"); } };
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", true]]) }, guide);
    await expect(collect(client.run("sess_native", "one guide"))).rejects.toThrow("owner went away");
    expect(rpc.calls.some(call => /session\/(resume|send|subscribe)/.test(call.method))).toBe(false);
  });

  it("exposes guide only for a locally owned active run and reuses the original RPC", async () => {
    const rpc = new ZCodeFixture();
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", false]]) });
    const adapter = new ZCodeRuntimeAdapter(client);
    expect(adapter.steer).toBeTypeOf("function");
    await expect(adapter.steer!("sess_native", "not running", "queue-one")).resolves.toBe(false);
    expect(rpc.calls).toEqual([]);
    rpc.prompt = async () => { rpc.emit("model.streaming", { kind: "text_delta", delta: "working" }); };
    const iterator = adapter.run("sess_native", "initial")[Symbol.asyncIterator]();
    await iterator.next();
    await expect(adapter.steer!("sess_native", "补充要求", "queue-one")).resolves.toBe(true);
    await expect(adapter.steer!("sess_native", "补充要求", "queue-one")).resolves.toBe(true);
    expect(rpc.calls.filter(call => call.method === "v4/command")).toHaveLength(1);
    expect(rpc.calls.find(call => call.method === "v4/command")?.params).toMatchObject({ sessionId: "sess_native", type: "sendText", payload: { text: "补充要求", requestedDelivery: "guide" } });
    expect(rpc.calls.filter(call => call.method === "session/send")).toHaveLength(1);
    expect(rpc.calls.some(call => call.method === "session/stop")).toBe(false);
    rpc.emit("turn.completed", {});
    while (!(await iterator.next()).done) {}
    await expect(adapter.steer!("sess_native", "after completion", "queue-two")).resolves.toBe(false);
  });

  it("does not steer an external session or an aborted local run", async () => {
    const rpc = new ZCodeFixture();
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", true]]) });
    await client.list();
    await expect(client.steer("sess_native", "foreign run", "queue-one")).resolves.toBe(false);
    expect(rpc.calls.some(call => call.method === "v4/command")).toBe(false);
    const owned = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", false]]) });
    rpc.prompt = async () => { rpc.emit("model.streaming", { kind: "text_delta", delta: "working" }); };
    const iterator = owned.run("sess_native", "initial")[Symbol.asyncIterator]();
    await iterator.next();
    await owned.abort("sess_native");
    await expect(owned.steer("sess_native", "stopped", "queue-two")).resolves.toBe(false);
    while (!(await iterator.next()).done) {}
    expect(rpc.calls.some(call => call.method === "v4/command")).toBe(false);
  });
  it("uses the same external ownership for discovery and details, and clears it on completion", async () => {
    const rpc = new ZCodeFixture();
    let running = true;
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", running]]) });
    const adapter = new ZCodeRuntimeAdapter(client);
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "running", occupancy: "owned-externally", canResume: false });
    expect(await adapter.getSession("sess_native")).toMatchObject({ status: "running", occupancy: "owned-externally", canResume: false });
    running = false;
    expect(await adapter.getSession("sess_native")).toMatchObject({ status: "idle", occupancy: "available", canResume: true });
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "idle", occupancy: "available", canResume: true });
  });

  it("blocks a desktop-owned turn before resume, subscription or send", async () => {
    const rpc = new ZCodeFixture();
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", true]]) });
    await expect(collect(client.run("sess_native", "do not duplicate"))).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    expect(rpc.calls.some(call => ["session/resume", "session/subscribe", "session/send"].includes(call.method))).toBe(false);
  });

  it("rechecks desktop ownership after an asynchronous resume", async () => {
    const rpc = new ZCodeFixture();
    let checks = 0;
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", ++checks >= 3]]) });
    await expect(collect(client.run("sess_native", "do not race"))).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    expect(rpc.calls.some(call => call.method === "session/resume")).toBe(true);
    expect(rpc.calls.some(call => ["session/subscribe", "session/send"].includes(call.method))).toBe(false);
  });

  it("allows continuation once the external turn ends without retaining a cached running flag", async () => {
    const rpc = new ZCodeFixture();
    let running = true;
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", running]]) });
    await client.list();
    running = false;
    expect((await collect(client.run("sess_native", "continue after completion"))).at(-1)).toMatchObject({ type: "done" });
    expect(rpc.calls.filter(call => call.method === "session/send")).toHaveLength(1);
  });

  it("keeps an owned local run visible when native list and desktop logs both report idle", async () => {
    const rpc = new ZCodeFixture();
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    rpc.prompt = async () => { started(); };
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", false]]) });
    const adapter = new ZCodeRuntimeAdapter(client);
    const pending = collect(adapter.run("sess_native", "local turn"));
    await ready;
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "running", occupancy: "owned-by-customer-agent", canResume: true });
    rpc.emit("turn.completed", {}); await pending;
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "idle", occupancy: "available" });
  });
});

/** Native resident runtimes expire independently of the RPC process. */
class ResidentZCodeFixture extends ZCodeFixture {
  resident = false;
  constructor(private readonly unavailableMessage = "Session is not active: sess_native") { super(); }
  override async request(method: string, params: NativeJsonPacket): Promise<NativeJsonPacket> {
    if (["session/read", "session/messages", "session/subscribe"].includes(method) && !this.resident) {
      this.calls.push({ method, params });
      throw new NativeRpcError(this.unavailableMessage, -32004);
    }
    const result = await super.request(method, params);
    if (method === "session/resume" || method === "session/create") this.resident = true;
    return result;
  }
}

describe.each(["Session is not active: sess_native", "Session runtime is not ready"])("ZCode resident runtime recovery (%s)", unavailableMessage => {
  it("shares the initial resume across concurrent history requests", async () => {
    const rpc = new ResidentZCodeFixture(unavailableMessage); const client = new ZCodeClient(rpc);
    await Promise.all([client.read("sess_native"), client.read("sess_native")]);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
  });

  it("reloads persisted history after an idle resident is evicted", async () => {
    const rpc = new ResidentZCodeFixture(unavailableMessage); const client = new ZCodeClient(rpc);
    await client.read("sess_native");
    rpc.resident = false;
    expect((await client.read("sess_native")).messages).toMatchObject([{ content: "native history" }]);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(2);
    expect(rpc.calls.some(call => call.method === "session/send")).toBe(false);
  });

  it("shares concurrent restores instead of materializing a session multiple times", async () => {
    const rpc = new ResidentZCodeFixture(unavailableMessage); const client = new ZCodeClient(rpc);
    await client.read("sess_native");
    rpc.resident = false;
    const details = await Promise.all([client.read("sess_native"), client.read("sess_native"), client.read("sess_native")]);
    expect(details.every(detail => detail.messages[0]?.content === "native history")).toBe(true);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(2);
  });

  it("restores before continuing an evicted session and sends the turn once", async () => {
    const rpc = new ResidentZCodeFixture(unavailableMessage); const client = new ZCodeClient(rpc);
    await client.read("sess_native");
    rpc.resident = false;
    expect((await collect(client.run("sess_native", "continue"))).at(-1)).toEqual({ type: "done", finalText: "native answer" });
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(2);
    expect(rpc.calls.filter(call => call.method === "session/send")).toHaveLength(1);
  });

  it("retries the history read when eviction occurs between snapshot and messages", async () => {
    const rpc = new ResidentZCodeFixture(unavailableMessage); const client = new ZCodeClient(rpc);
    const request = rpc.request.bind(rpc);
    let evict = true;
    rpc.request = async (method, params) => {
      const result = await request(method, params);
      if (method === "session/read" && evict) { evict = false; rpc.resident = false; }
      return result;
    };
    expect((await client.read("sess_native")).messages[0]?.content).toBe("native history");
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(2);
  });

  it("does not reactivate an unexpectedly missing resident while a local turn is live", async () => {
    const rpc = new ResidentZCodeFixture(unavailableMessage); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => { rpc.emit("model.streaming", { kind: "text_delta", delta: "running" }); };
    const run = client.run("sess_native", "work")[Symbol.asyncIterator]();
    await run.next();
    rpc.resident = false;
    try {
      await expect(client.read("sess_native")).rejects.toMatchObject({ message: unavailableMessage });
      expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
    } finally {
      rpc.resident = true;
      rpc.emit("turn.completed", {});
      while (!(await run.next()).done) {}
    }
  });

  it("rechecks ownership after restoring an evicted session", async () => {
    const rpc = new ResidentZCodeFixture(unavailableMessage); const client = new ZCodeClient(rpc);
    await client.read("sess_native");
    rpc.resident = false; rpc.session.status = "running";
    await expect(collect(client.run("sess_native", "continue"))).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    expect(rpc.calls.some(call => call.method === "session/send")).toBe(false);
  });

  it.each([
    new NativeRpcError("Native configuration failed", -32004),
    new NativeRpcError("Session is not active: sess_native", -32603),
    new NativeRpcError("Session runtime is not ready", -32603),
    new NativeRpcError("Session not found: sess_native", -32004),
    new NativeRpcError("Session is not active: other_session", -32004),
  ])("preserves unrelated native failures without retrying", async error => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    const request = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method === "session/read") throw error;
      return request(method, params);
    };
    await expect(client.read("sess_native")).rejects.toBe(error);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
  });

  it("bounds recovery to one retry when native reactivation cannot repair the session", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    const request = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method === "session/read") throw new NativeRpcError(unavailableMessage, -32004);
      return request(method, params);
    };
    await expect(client.read("sess_native")).rejects.toMatchObject({ message: unavailableMessage });
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(2);
  });

  it("does not retry a send whose acceptance is unknown", async () => {
    const rpc = new ResidentZCodeFixture(unavailableMessage); const client = new ZCodeClient(rpc);
    const request = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method === "session/send") {
        rpc.calls.push({ method, params });
        throw new NativeRpcError(unavailableMessage, -32004);
      }
      return request(method, params);
    };
    await expect(collect(client.run("sess_native", "continue"))).rejects.toMatchObject({ message: unavailableMessage });
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
    expect(rpc.calls.filter(call => call.method === "session/send")).toHaveLength(1);
  });
});

describe("ZCode native-visible child discovery", () => {
  class ChildFixture extends ZCodeFixture {
    childIds = ["sess_child"];
    childTitle = "Child";
    override async request(method: string, params: NativeJsonPacket): Promise<NativeJsonPacket> {
      if (method === "session/subagents") {
        this.calls.push({ method, params });
        return { childSessionIds: this.childIds, running: [], ended: { total: this.childIds.length, items: [] } };
      }
      if (method === "session/list" && Array.isArray(params.sessionIds)) {
        this.calls.push({ method, params });
        return { sessions: params.sessionIds.filter(id => this.childIds.includes(String(id))).map(id => ({
          ...this.session, sessionId: id, parentSessionId: this.session.sessionId, sessionKind: "subagent_child", title: this.childTitle,
        })) };
      }
      return super.request(method, params);
    }
  }

  it("retains native parent identity and marks child sessions read-only without resuming them", async () => {
    const rpc = new ChildFixture();
    const sessions = await new ZCodeRuntimeAdapter(new ZCodeClient(rpc)).discoverSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).toMatchObject({ nativeSessionId: "sess_child", parentSessionId: encodeUnifiedSessionId("zcode", "sess_native"), readOnly: true, canResume: false });
    expect(rpc.calls.some(call => ["session/resume", "session/create", "session/send"].includes(call.method))).toBe(false);
  });

  it("refreshes child metadata and re-discovers children when the parent changes", async () => {
    const rpc = new ChildFixture();
    const client = new ZCodeClient(rpc);
    await client.list();
    rpc.childTitle = "Externally updated";
    expect((await client.list()).find(row => row.id === "sess_child")?.title).toBe("Externally updated");
    expect(rpc.calls.filter(call => call.method === "session/subagents")).toHaveLength(1);
    rpc.session.updatedAt += 1;
    rpc.childIds.push("sess_new_child");
    expect((await client.list()).map(row => row.id)).toContain("sess_new_child");
    rpc.childIds = [];
    expect((await client.list()).map(row => row.id)).toEqual(["sess_native"]);
  });
});

describe("ZCode native NDJSON adapter", () => {
  it("reads externally appended native history again even while the loaded session stays idle", async () => {
    const rpc = new ZCodeFixture();
    const request = rpc.request.bind(rpc);
    let content = "Initial";
    rpc.request = async (method, params) => method === "session/messages"
      ? { messages: [{ info: { id: "latest", role: "assistant" }, parts: [{ type: "text", text: content }] }] }
      : request(method, params);
    const client = new ZCodeClient(rpc);
    expect((await client.read("sess_native")).messages[0].content).toBe("Initial");
    content = "Updated in the native app";
    expect((await client.read("sess_native")).messages[0].content).toBe(content);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
  });
  it("persists a real native session immediately instead of returning a lost deferred session", async () => {
    const rpc = new ZCodeFixture(); const adapter = new ZCodeRuntimeAdapter(new ZCodeClient(rpc));
    const created = await adapter.create({ title: "Owned", cwd: "/native/zcode" });
    expect(created.agentType).toBe("zcode"); expect(created.nativeSessionId).toBe("sess_native");
    expect(rpc.calls[0]).toMatchObject({ method: "session/create", params: { persistence: "immediate", workspace: { workspacePath: "/native/zcode", workspaceKey: "/native/zcode" } } });
    expect((await adapter.getSession("sess_native")).messages).toMatchObject([{ role: "user", content: "native history" }]);
    expect(await adapter.listModels()).toEqual([{ id: "native-model", providerID: "zcode-native", displayName: "Native model", providerDisplayName: "Native provider", description: undefined }]);
  });

  it("streams native events once per sequence and retains provider/model identity per turn", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => {
      rpc.emit("model.streaming", { kind: "text_delta", delta: "answer" });
      rpc.listener("session/event", { sessionId: "sess_native", seq: rpc.sequence, type: "model.streaming", payload: { kind: "text_delta", delta: "DUPLICATE" } });
      rpc.emit("tool.updated", { kind: "started", toolCallId: "tool", toolName: "Read", input: { path: "README" } });
      rpc.emit("tool.updated", { kind: "result", toolCallId: "tool", output: "native result" });
      rpc.emit("turn.completed", {});
    };
    const events = await collect(client.run("sess_native", "request", undefined, { model: { providerID: "zcode-native", id: "native-model" } }));
    expect(events.map(event => event.type)).toEqual(["text_chunk", "tool_call", "tool_result", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", finalText: "answer" });
    expect(rpc.calls.find(call => call.method === "session/send")?.params).toMatchObject({ sessionId: "sess_native", modelSelection: { providerId: "zcode-native", modelId: "native-model" } });
    await collect(client.run("sess_native", "second turn"));
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
  });

  it("refreshes an empty catalog from an idle native session even when it is already loaded", async () => {
    const rpc = new ZCodeFixture(); rpc.models = [];
    const client = new ZCodeClient(rpc);
    await client.read("sess_native");
    rpc.models = [{ ref: { providerId: "native-provider", modelId: "new-model" }, label: "New native model" }];
    expect(await client.listModels()).toMatchObject([{ id: "new-model", providerID: "native-provider" }]);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(2);
    await client.read("sess_native");
    expect(await client.listModels()).toMatchObject([{ id: "new-model", providerID: "native-provider" }]);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(2);
  });

  it("streams retry progress once per native sequence and still waits for the actual turn result", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => {
      rpc.emit("session.updated", { type: "model_request_started", attempt: 1, maxAttempts: 11 });
      rpc.emit("session.updated", { type: "model_retry_scheduled", nextAttempt: 2, maxAttempts: 11, message: "Native quota limit", delayMs: 50_030 });
      rpc.listener("session/event", { sessionId: "sess_native", seq: rpc.sequence, type: "session.updated", payload: { type: "model_retry_scheduled", message: "DUPLICATE" } });
      rpc.listener("session/event", { sessionId: "another-session", seq: 999, type: "session.updated", payload: { type: "model_retry_scheduled", message: "FOREIGN" } });
      rpc.emit("session.updated", { type: "model_request_started", attempt: 2, maxAttempts: 11 });
      rpc.emit("model.streaming", { kind: "text_delta", delta: "Recovered native response" });
      rpc.emit("session.updated", { type: "model_request_completed", attempt: 2, maxAttempts: 11 });
      rpc.emit("turn.completed", {});
    };

    const events = await collect(client.run("sess_native", "request"));
    expect(events.map(event => event.type)).toEqual(["runtime_progress", "runtime_progress", "runtime_progress", "text_chunk", "runtime_progress", "done"]);
    expect(events[1]).toMatchObject({ phase: "retry", label: "ZCode 请求重试 2/11", detail: "Native quota limit\n原生运行时将在 51 秒后重试" });
    expect(events[2]).not.toHaveProperty("detail");
    expect(events.at(-1)).toEqual({ type: "done", finalText: "Recovered native response" });
    expect(JSON.stringify(events)).not.toMatch(/DUPLICATE|FOREIGN/);
  });

  it("keeps repeated quota retries non-terminal until ZCode reports an actual failed turn", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => {
      for (const nextAttempt of [2, 3]) rpc.emit("session.updated", {
        type: "model_retry_scheduled", nextAttempt, maxAttempts: 11, message: "Native five-hour quota exhausted", statusCode: 429,
      });
      rpc.emit("turn.failed", { error: { code: "NATIVE_MODEL_LIMIT", message: "Native five-hour quota exhausted" } });
    };
    const events = await collect(client.run("sess_native", "request"));
    expect(events.map(event => event.type)).toEqual(["runtime_progress", "runtime_progress", "error"]);
    expect(events.at(-1)).toEqual({ type: "error", code: "NATIVE_MODEL_LIMIT", message: "Native five-hour quota exhausted" });
    expect(rpc.calls.some(call => call.method === "session/stop")).toBe(false);
  });

  it("preserves advertised reasoning levels and their native default through history reads", async () => {
    const rpc = new ZCodeFixture();
    rpc.models[0].reasoning = { levels: [{ value: "low" }, { value: "high" }, { value: "max" }, { value: "high" }, { value: "unknown" }], defaultLevel: "max" };
    const client = new ZCodeClient(rpc);
    await client.read("sess_native");
    expect(await client.listModels()).toMatchObject([{ reasoningEfforts: ["low", "high", "max"] }]);
    await collect(client.run("sess_native", "request", undefined, { model: { providerID: "zcode-native", id: "native-model" } }));
    expect(rpc.calls.find(call => call.method === "session/send")?.params).toMatchObject({ modelSelection: {
      providerId: "zcode-native", modelId: "native-model", options: { reasoningLevel: "max" },
    } });
  });

  it("keeps an explicit effort instead of the native model default", async () => {
    const rpc = new ZCodeFixture();
    rpc.models[0].reasoning = { levels: [{ value: "low" }, { value: "max" }], defaultLevel: "max" };
    const client = new ZCodeClient(rpc);
    await collect(client.run("sess_native", "request", undefined, { model: { providerID: "zcode-native", id: "native-model" }, reasoningEffort: "low" }));
    expect(rpc.calls.find(call => call.method === "session/send")?.params).toMatchObject({ modelSelection: { options: { reasoningLevel: "low" } } });
  });

  it.each(["unknown", "max"])("does not invent an unadvertised native default %s", defaultLevel => {
    const rpc = new ZCodeFixture();
    rpc.models[0].reasoning = { levels: [{ value: "high" }], defaultLevel };
    const client = new ZCodeClient(rpc);
    return collect(client.run("sess_native", "request", undefined, { model: { providerID: "zcode-native", id: "native-model" } })).then(() => {
      expect(rpc.calls.find(call => call.method === "session/send")?.params.modelSelection).toEqual({ providerId: "zcode-native", modelId: "native-model" });
    });
  });

  it("scopes model defaults to the native provider as well as the model id", async () => {
    const rpc = new ZCodeFixture();
    rpc.models[0].reasoning = { levels: [{ value: "max" }], defaultLevel: "max" };
    rpc.models.push({ ref: { providerId: "other-native", modelId: "native-model" }, reasoning: { levels: [{ value: "low" }], defaultLevel: "low" } });
    const client = new ZCodeClient(rpc);
    await collect(client.run("sess_native", "request", undefined, { model: { providerID: "other-native", id: "native-model" } }));
    expect(rpc.calls.find(call => call.method === "session/send")?.params).toMatchObject({ modelSelection: { providerId: "other-native", options: { reasoningLevel: "low" } } });
  });

  it("does not resume a foreign active writer to discover native models", async () => {
    const rpc = new ZCodeFixture(); rpc.session.status = "running"; rpc.models = [];
    const client = new ZCodeClient(rpc);
    expect(await client.listModels()).toEqual([]);
    expect(rpc.calls.some(call => call.method === "session/resume")).toBe(false);
  });

  it("preserves actual native configuration failures instead of reporting acceptance as success", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => rpc.emit("turn.failed", { error: { code: "CONFIGURATION_ERROR", message: "Select a model before continuing" } });
    expect(await collect(client.run("sess_native", "request"))).toEqual([{ type: "error", code: "CONFIGURATION_ERROR", message: "Select a model before continuing" }]);
  });

  it("waits for explicit permission selection and returns the native decision payload", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    let decision: unknown;
    rpc.prompt = async () => {
      decision = await rpc.handler("interaction/requestPermission", { sessionId: "sess_native", toolName: "Write", reason: "Edit file", options: [{ optionId: "allow", name: "Allow once", response: { decision: "allow" } }, { optionId: "deny", name: "Deny", response: { decision: "deny", reason: "Rejected" } }] });
      rpc.emit("turn.completed", {});
    };
    const iterator = client.run("sess_native", "permission")[Symbol.asyncIterator]();
    const next = await iterator.next(); if (next.value.type !== "ask_user") throw new Error("Expected approval");
    expect(decision).toBeUndefined();
    await expect(client.answerQuestion(next.value.questionId, { answer: "unknown" })).rejects.toMatchObject({ code: "QUESTION_ANSWER_FAILED" });
    await client.answerQuestion(next.value.questionId, { answer: "Deny", selectedIndices: [1] });
    while (!(await iterator.next()).done) {}
    expect(decision).toEqual({ decision: "deny", reason: "Rejected" });
    expect(await rpc.handler("interaction/requestPermission", { sessionId: "sess_native" })).toMatchObject({ decision: "deny" });
  });

  it("maps native user questions without enabling native automatic resolution", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    let answer: unknown;
    rpc.prompt = async () => {
      answer = await rpc.handler("interaction/requestUserInput", { sessionId: "sess_native", questions: [{ question: "Choose branch", options: [{ value: "main", label: "Main" }, { value: "feature", label: "Feature" }] }] });
      rpc.emit("turn.completed", {});
    };
    const iterator = client.run("sess_native", "question")[Symbol.asyncIterator]();
    const next = await iterator.next(); if (next.value.type !== "ask_user") throw new Error("Expected question");
    await client.answerQuestion(next.value.questionId, { answer: "Feature", selectedIndices: [1] });
    while (!(await iterator.next()).done) {}
    expect(answer).toEqual({ action: "accept", content: { answers: { "Choose branch": "feature" } } });
    await expect(rpc.handler("interaction/unsupportedOperation", {})).rejects.toThrow("Unsupported");
  });

  it("coalesces forty native reannouncements and reuses the reply after answering", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    const params = { sessionId: "sess_native", requestId: "perm-question", toolCallId: "call-question", toolName: "AskUserQuestion",
      questions: [{ question: "强制改密，如何处理？", options: [{ value: "pause", label: "暂停" }] }] };
    let replies: unknown[] = [];
    let lateReply: unknown;
    rpc.prompt = async () => {
      rpc.emit("model.streaming", { kind: "tool_call", toolCallId: params.toolCallId, toolName: "AskUserQuestion", input: { questions: params.questions } });
      rpc.emit("tool.updated", { kind: "started", toolCallId: params.toolCallId, toolName: "AskUserQuestion" });
      replies = await Promise.all(Array.from({ length: 40 }, () => rpc.handler("interaction/requestUserInput", params)));
      lateReply = await rpc.handler("interaction/requestUserInput", params);
      rpc.emit("turn.completed", {});
    };
    const iterator = client.run("sess_native", "question")[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.value.type !== "ask_user") throw new Error("Expected a dedicated question, not raw tool JSON");
    expect(first.value.question).toBe("强制改密，如何处理？");
    expect(replies).toEqual([]);
    await client.answerQuestion(first.value.questionId, { answer: "暂停", selectedIndices: [0] });
    const events = [first.value];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) events.push(next.value);
    expect(events.filter(event => event.type === "ask_user")).toHaveLength(1);
    expect(events.filter(event => event.type === "approval_resolved")).toHaveLength(1);
    expect(events.some(event => event.type === "tool_call")).toBe(false);
    expect(replies).toHaveLength(40);
    expect(replies.every(reply => JSON.stringify(reply) === JSON.stringify(lateReply))).toBe(true);
    expect(lateReply).toEqual({ action: "accept", content: { answers: { "强制改密，如何处理？": "pause" } } });
    expect(await client.answerQuestion(first.value.questionId, { answer: "again" })).toBe(false);
  });

  it("cancels every waiter for a reannounced request when the run is stopped", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    let replies: unknown[] = [];
    const params = { sessionId: "sess_native", requestId: "perm-question", questions: [{ question: "Continue?", options: [] }] };
    rpc.prompt = async () => { replies = await Promise.all([rpc.handler("interaction/requestUserInput", params), rpc.handler("interaction/requestUserInput", params)]); };
    const iterator = client.run("sess_native", "question")[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.value.type !== "ask_user") throw new Error("Expected question");
    await client.abort("sess_native");
    const events: AgentEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) events.push(next.value);
    expect(replies).toEqual([{ action: "cancel" }, { action: "cancel" }]);
    expect(events.filter(event => event.type === "approval_resolved")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn_aborted");
    expect(await client.answerQuestion(first.value.questionId, { answer: "too late" })).toBe(false);
  });

  it("renders three native questions and aggregates single-select and multi-select replies once", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    const params = { sessionId: "sess_native", requestId: "multi-question", questions: [
      { question: "你想要的使用形态是什么？", options: [{ value: "digest", label: "摘要" }, { value: "both", label: "两者都要" }] },
      { question: "定时任务跑在哪里？", options: [{ value: "actions", label: "GitHub Actions" }] },
      { question: "结果推送到哪里？", multiSelect: true, options: [{ value: "wecom", label: "企业微信" }, { value: "wiki", label: "Wiki" }] },
    ] };
    let replies: unknown[] = [];
    rpc.prompt = async () => {
      replies = await Promise.all(Array.from({ length: 3 }, () => rpc.handler("interaction/requestUserInput", params)));
      rpc.emit("turn.completed", {});
    };
    const iterator = client.run("sess_native", "ask three questions")[Symbol.asyncIterator]();
    const questions: Extract<AgentEvent, { type: "ask_user" }>[] = [];
    for (let index = 0; index < 3; index++) {
      const event = (await iterator.next()).value;
      if (event.type !== "ask_user") throw new Error("Expected a question card");
      questions.push(event);
    }
    expect(new Set(questions.map(question => question.questionId)).size).toBe(3);
    expect(questions[2].multiSelect).toBe(true);
    await client.answerQuestion(questions[2].questionId, { answer: "企业微信, Wiki", selectedIndices: [0, 1] });
    await client.answerQuestion(questions[0].questionId, { answer: "两者都要", selectedIndices: [1] });
    expect(replies).toEqual([]);
    await client.answerQuestion(questions[1].questionId, { answer: "GitHub Actions", selectedIndices: [0] });
    const events: AgentEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) events.push(next.value);
    expect(events.filter(event => event.type === "ask_user")).toHaveLength(0);
    expect(events.filter(event => event.type === "approval_resolved")).toHaveLength(3);
    expect(replies).toHaveLength(3);
    for (const reply of replies) expect(reply).toEqual({ action: "accept", content: { answers: {
      "你想要的使用形态是什么？": "both", "定时任务跑在哪里？": "actions", "结果推送到哪里？": "wecom, wiki",
    } } });
  });

  it("cancels the whole native form when a run stops after a partial answer", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    let reply: unknown;
    rpc.prompt = async () => { reply = await rpc.handler("interaction/requestUserInput", { sessionId: "sess_native", requestId: "multi-question", questions: [
      { question: "First?", options: [] }, { question: "Second?", options: [] },
    ] }); };
    const iterator = client.run("sess_native", "question")[Symbol.asyncIterator]();
    const first = (await iterator.next()).value;
    const second = (await iterator.next()).value;
    if (first.type !== "ask_user" || second.type !== "ask_user") throw new Error("Expected question cards");
    await client.answerQuestion(first.questionId, { answer: "first answer" });
    expect(reply).toBeUndefined();
    await client.abort("sess_native");
    const events: AgentEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) events.push(next.value);
    expect(reply).toEqual({ action: "cancel" });
    expect(events.filter(event => event.type === "approval_resolved")).toHaveLength(2);
    expect(await client.answerQuestion(second.questionId, { answer: "too late" })).toBe(false);
  });

  it("preserves multi-select and maps selected indices to native values", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    let reply: unknown;
    rpc.prompt = async () => {
      reply = await rpc.handler("interaction/requestUserInput", { sessionId: "sess_native", requestId: "perm-question", questions: [{
        question: "Checks?", multiSelect: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      }] });
      rpc.emit("turn.completed", {});
    };
    const iterator = client.run("sess_native", "question")[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.value.type !== "ask_user") throw new Error("Expected question");
    expect(first.value.multiSelect).toBe(true);
    await expect(client.answerQuestion(first.value.questionId, { answer: "invalid", selectedIndices: [2] })).rejects.toMatchObject({ code: "QUESTION_ANSWER_FAILED" });
    await client.answerQuestion(first.value.questionId, { answer: "A, B", selectedIndices: [0, 1] });
    while (!(await iterator.next()).done) {}
    expect(reply).toEqual({ action: "accept", content: { answers: { "Checks?": "a, b" } } });
  });

  it("declines native account-header requests with the ZCode protocol result, without echoing credentials", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    const result = await rpc.handler("interaction/requestProviderRuntimeHeaders", {
      sessionId: "sess_native", requestId: "native-account-request", privateContext: "must-not-be-reflected",
    });
    expect(result).toEqual({
      headersApplied: false,
      errorMessage: "ZCode requires its native host account bridge for model credentials; AgentRoam does not substitute CA model credentials.",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-reflected");
    expect(rpc.calls).toEqual([]);
    await client.dispose();
  });

  it("keeps a missing native account bridge a failed turn, not an approval or successful response", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => {
      const result = await rpc.handler("interaction/requestProviderRuntimeHeaders", { sessionId: "sess_native" }) as { headersApplied: boolean; errorMessage: string };
      rpc.emit("turn.failed", { error: { code: "MODEL_CREDENTIALS_UNAVAILABLE", message: result.errorMessage } });
    };
    expect(await collect(client.run("sess_native", "request"))).toEqual([{
      type: "error", code: "MODEL_CREDENTIALS_UNAVAILABLE",
      message: "ZCode requires its native host account bridge for model credentials; AgentRoam does not substitute CA model credentials.",
    }]);
  });

  it("stops the native session and emits abort rather than done", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => rpc.emit("model.streaming", { kind: "text_delta", delta: "partial" });
    const iterator = client.run("sess_native", "long turn")[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("text_chunk"); await client.abort("sess_native");
    expect((await iterator.next()).value).toEqual({ type: "turn_aborted" });
    expect((await iterator.next()).done).toBe(true);
    expect(rpc.calls.at(-1)).toMatchObject({ method: "session/stop", params: { sessionId: "sess_native" } });
  });

  it("does not reuse fallback reasoning IDs across turns without native part or turn IDs", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => {
      rpc.listener("session/event", { sessionId: "sess_native", seq: ++rpc.sequence, type: "model.streaming", payload: { kind: "reasoning_delta", delta: "Check first" } });
      rpc.emit("model.streaming", { kind: "text_delta", delta: "Answer" });
      rpc.emit("turn.completed", {});
    };
    const first = await collect(client.run("sess_native", "First"));
    const second = await collect(client.run("sess_native", "Second"));
    const firstThought = first.find(event => event.type === "reasoning_summary_delta");
    const secondThought = second.find(event => event.type === "reasoning_summary_delta");
    expect(firstThought?.itemId).toBeTruthy();
    expect(secondThought?.itemId).not.toBe(firstThought?.itemId);
    expect(second.at(-1)).toEqual({ type: "done", finalText: "Answer" });
  });

  it("reads native message/tool/reasoning parts", async () => {
    const messages = decodeZCodeHistory([{ info: { id: "message", role: "assistant" }, parts: [{ type: "text", text: "text" }, { id: "reason", type: "reasoning", text: "thought" }, { type: "tool", callID: "call", tool: "Read", state: { input: { path: "README" }, status: "completed", output: "native result" } }] }]);
    expect(messages[0]).toMatchObject({ role: "assistant", content: "text", presentation: { reasoning: [{ text: "thought" }] }, toolCalls: [{ id: "call", name: "Read" }] });
    expect(messages[1]).toMatchObject({ role: "tool", content: "native result", toolCallId: "call" });
  });
});

describe("ZCode image attachment transport", () => {
  it("sends two native image attachments in order with unchanged text and model selection", async () => {
    const { client, rpc } = await imageClient();
    const events = await collect(client.run("sess_native", "compare these photos", [pngImage, gifImage], {
      model: { id: "native-model", providerID: "zcode-native" },
    }));
    const sends = rpc.calls.filter(call => call.method === "session/send");
    expect(sends).toHaveLength(1);
    expect(sends[0].params).toMatchObject({ content: "compare these photos", modelSelection: { providerId: "zcode-native", modelId: "native-model" } });
    const attachments = sends[0].params.attachments as ZCodeImageAttachment[];
    expect(attachments).toMatchObject([
      { kind: "image", filename: "image-1.png", mimeType: "image/png" },
      { kind: "image", filename: "image-2.gif", mimeType: "image/gif" },
    ]);
    for (const [index, source] of [pngImage, gifImage].entries()) {
      const bytes = Buffer.from(source.split(",")[1], "base64");
      expect(await readFile(attachments[index].localPath)).toEqual(bytes);
      expect(attachments[index].sizeBytes).toBe(bytes.length);
      if (process.platform !== "win32") expect((await stat(attachments[index].localPath)).mode & 0o777).toBe(0o600);
    }
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "native answer" });
  });

  it("accepts an image-only message without embedding large photo bytes in the RPC frame", async () => {
    const { client, rpc } = await imageClient();
    const bytes = Buffer.alloc(13 * 1024 * 1024);
    Buffer.from(pngImage.split(",")[1], "base64").copy(bytes);
    await collect(client.run("sess_native", "", [`data:image/png;base64,${bytes.toString("base64")}`]));
    const params = rpc.calls.find(call => call.method === "session/send")!.params;
    expect(params.content).toBe("");
    expect(JSON.stringify(params).length).toBeLessThan(2048);
    const attachment = (params.attachments as ZCodeImageAttachment[])[0];
    expect((await stat(attachment.localPath)).size).toBe(bytes.length);
    expect(createHash("sha256").update(await readFile(attachment.localPath)).digest("hex"))
      .toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it.each(["https://example.com/photo.png", "data:image/png;base64,AAAA", "data:image/png;base64,aQ=", "data:text/plain;base64,aGVsbG8="])("rejects invalid image input before contacting ZCode: %s", async image => {
    const { client, rpc } = await imageClient();
    await expect(collect(client.run("sess_native", "image", [image]))).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
    expect(rpc.calls).toEqual([]);
  });

  it("does not drop images when a desktop-owned session can only receive text guidance", async () => {
    const rpc = new ZCodeFixture();
    const guide = { available: async () => true, steer: vi.fn(async () => true) };
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["sess_native", true]]) }, guide);
    await expect(collect(client.run("sess_native", "photo", [pngImage]))).rejects.toThrow("等待任务结束后发送图片");
    expect(guide.steer).not.toHaveBeenCalled();
    expect(rpc.calls.some(call => /session\/(resume|send|subscribe)/.test(call.method))).toBe(false);
  });

  it("keeps plain-text sends free of attachment fields", async () => {
    const { client, rpc } = await imageClient();
    await collect(client.run("sess_native", "text only"));
    expect(rpc.calls.find(call => call.method === "session/send")!.params).not.toHaveProperty("attachments");
  });

  it("restores both native artifact images after reading history and tolerates missing previews", async () => {
    const { client, rpc } = await imageClient();
    await collect(client.run("sess_native", "photos", [pngImage, gifImage]));
    const attachments = rpc.calls.find(call => call.method === "session/send")!.params.attachments as ZCodeImageAttachment[];
    const parts = attachments.map((image, index) => ({ type: "file", mime: image.mimeType,
      url: `zcode-artifact://sess_native/image-${index}`, source: { type: "file", path: image.localPath } }));
    const request = rpc.request.bind(rpc);
    rpc.request = async (method, params) => method === "session/messages"
      ? { messages: [{ info: { role: "user", id: "image-input" }, parts: [{ type: "text", text: "photos" }, ...parts] }] }
      : request(method, params);
    expect((await client.read("sess_native")).messages[0]).toMatchObject({ content: "photos", images: [pngImage, gifImage] });
    await rm(attachments[0].localPath);
    expect((await client.read("sess_native")).messages[0]).toMatchObject({ content: "photos", images: [gifImage] });
  });
});

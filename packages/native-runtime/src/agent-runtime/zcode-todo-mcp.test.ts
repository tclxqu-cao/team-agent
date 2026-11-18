import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent/core";
import { NativeRpcError, type NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import { TODO_NATIVE_INJECTION_SUPPORT, type NativeTodoMcpConfiguration } from "./runtime-tool-injection.js";
import { ZCodeClient } from "./zcode-client.js";

const configuration = (name = "a"): NativeTodoMcpConfiguration => ({
  command: "/usr/local/bin/node", args: ["/tools/todo-mcp.mjs"], env: { AGENTROAM_TODO_DESCRIPTOR: `/tmp/todo-${name}.json` },
});
const expectedServers = (name = "a") => [{ name: "agentroam-todo", command: "/usr/local/bin/node", args: ["/tools/todo-mcp.mjs"],
  env: [{ name: "AGENTROAM_TODO_DESCRIPTOR", value: `/tmp/todo-${name}.json` }], isolation: "session", alwaysLoad: true }];

class TodoRpc implements NativeRpcConnection {
  readonly calls: Array<{ method: string; params: NativeJsonPacket }> = [];
  readonly residents = new Map<string, unknown>();
  readonly sentConfigurations: unknown[] = [];
  readonly sessions = new Map(["existing", "other"].map(sessionId => [sessionId, {
    sessionId, title: sessionId, workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" },
    createdAt: 1, updatedAt: 1, status: "idle",
  }]));
  closeResult = true;
  evictOnSubscribe = false;
  private sequence = 0;
  private listener: (method: string, params: NativeJsonPacket) => void = () => undefined;

  async request(method: string, params: NativeJsonPacket): Promise<NativeJsonPacket> {
    this.calls.push({ method, params });
    const id = String(params.sessionId);
    const snapshot = (sessionId: string) => ({ session: this.sessions.get(sessionId), settings: { model: { available: [] } } });
    if (method === "session/list") return { sessions: [...this.sessions.values()] };
    if (method === "session/subagents") return { childSessionIds: [] };
    if (method === "session/create") {
      this.residents.set("existing", params.mcpServers ?? []);
      return snapshot("existing");
    }
    if (method === "session/resume") {
      // The native server ignores new startup options for an existing resident.
      if (!this.residents.has(id)) this.residents.set(id, params.mcpServers ?? []);
      return snapshot(id);
    }
    if (method === "session/close") {
      if (this.closeResult) this.residents.delete(id);
      return { closed: this.closeResult };
    }
    if (method === "session/subscribe") {
      if (this.evictOnSubscribe) {
        this.evictOnSubscribe = false;
        this.residents.delete(id);
        throw new NativeRpcError(`Session is not active: ${id}`, -32004);
      }
      return { eventSeq: this.sequence };
    }
    if (method === "session/setMode") return {};
    if (method === "session/send") {
      this.sentConfigurations.push(this.residents.get(id));
      queueMicrotask(() => this.listener("session/event", { sessionId: id, seq: ++this.sequence, type: "turn.completed", payload: {} }));
      return { accepted: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  }
  async notify() {}
  onNotification(listener: typeof this.listener) { this.listener = listener; return () => undefined; }
  onRequest() {}
  onFailure() { return () => undefined; }
  async dispose() {}
}

async function collect(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

const clientFor = (rpc: TodoRpc) => new ZCodeClient(rpc, { readMany: async () => new Map() });

describe("ZCode session-isolated Todo MCP", () => {
  it("advertises the verified native session injection capability", () => {
    expect(TODO_NATIVE_INJECTION_SUPPORT.zcode).toBe("session");
  });

  it.each([
    { command: "/opt/agent roam/bin/node", args: ["/srv/Agent Roam/todo server.mjs", "--service", "computer-linux"],
      env: { AGENTROAM_TODO_DESCRIPTOR: "/run/user/1001/Agent Roam/service.json", AGENTROAM_DISCOVERY_DIR: "/srv/Agent Roam/discovery" } },
    { command: "C:\\Program Files\\nodejs\\node.exe", args: ["D:\\Agent Roam\\runtime\\todo server.mjs", "--service", "computer-windows"],
      env: { AGENTROAM_TODO_DESCRIPTOR: "C:\\Users\\Alice Smith\\AppData\\Local\\Agent Roam\\service.json", AGENTROAM_DISCOVERY_DIR: "D:\\Agent Roam\\discovery" } },
  ])("passes executable, spaced arguments and descriptor paths through unchanged: $command", async config => {
    const rpc = new TodoRpc();
    const client = clientFor(rpc);
    await client.create({ title: "Portable Todo", cwd: "/workspace", todoMcp: config });
    const servers = rpc.calls.find(call => call.method === "session/create")?.params.mcpServers as NativeJsonPacket[];
    expect(servers).toEqual([{ name: "agentroam-todo", command: config.command, args: config.args,
      env: Object.entries(config.env).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => ({ name, value })),
      isolation: "session", alwaysLoad: true }]);
    await collect(client.run("existing", "Portable task", undefined, { todoMcp: config }));
    expect(rpc.sentConfigurations).toEqual([servers]);
  });

  it("injects the strict native stdio shape at creation and reuses it for the first send", async () => {
    const rpc = new TodoRpc();
    const client = clientFor(rpc);
    const session = await client.create({ title: "Todo", cwd: "/workspace", todoMcp: configuration() });
    expect(rpc.calls.find(call => call.method === "session/create")?.params.mcpServers).toEqual(expectedServers());
    await collect(client.run(session.id, "Task", undefined, { todoMcp: configuration() }));
    expect(rpc.sentConfigurations).toEqual([expectedServers()]);
    expect(rpc.calls.some(call => call.method === "session/close" || call.method === "session/resume")).toBe(false);
    expect(rpc.calls.find(call => call.method === "session/send")?.params).not.toHaveProperty("mcpServers");
  });

  it("passes a cold resume the MCP configuration and reuses unchanged residents", async () => {
    const rpc = new TodoRpc();
    const client = clientFor(rpc);
    await collect(client.run("existing", "Task", undefined, { todoMcp: configuration() }));
    await collect(client.run("existing", "Task again", undefined, { todoMcp: configuration() }));
    expect(rpc.calls.filter(call => call.method === "session/resume")).toEqual([
      { method: "session/resume", params: { sessionId: "existing", mcpServers: expectedServers() } },
    ]);
    expect(rpc.calls.some(call => call.method === "session/close")).toBe(false);
    expect(rpc.sentConfigurations).toEqual([expectedServers(), expectedServers()]);
  });

  it("releases only its idle resident before applying new startup MCP configuration", async () => {
    const rpc = new TodoRpc();
    const client = clientFor(rpc);
    await client.create({ title: "Before Todo", cwd: "/workspace" });
    await collect(client.run("existing", "Task", undefined, { todoMcp: configuration() }));
    expect(rpc.calls.map(call => call.method)).toEqual([
      "session/create", "session/close", "session/resume", "session/subscribe", "session/send",
    ]);
    expect(rpc.sentConfigurations).toEqual([expectedServers()]);
    await collect(client.run("existing", "New Todo service", undefined, { todoMcp: configuration("b") }));
    expect(rpc.calls.filter(call => call.method === "session/close")).toHaveLength(2);
    expect(rpc.sentConfigurations[1]).toEqual(expectedServers("b"));
  });

  it("fails before subscribe or send when the native resident was not released", async () => {
    const rpc = new TodoRpc();
    const client = clientFor(rpc);
    await client.create({ title: "Before Todo", cwd: "/workspace" });
    rpc.closeResult = false;
    await expect(collect(client.run("existing", "Task", undefined, { todoMcp: configuration() }))).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
    expect(rpc.calls.some(call => ["session/resume", "session/subscribe", "session/send"].includes(call.method))).toBe(false);
  });

  it.each(["session/close", "session/resume", "session/subscribe"])("honors a stop during Todo preparation at %s", async phase => {
    const rpc = new TodoRpc();
    const client = clientFor(rpc);
    await client.create({ title: "Before Todo", cwd: "/workspace" });
    const original = rpc.request.bind(rpc);
    let reached!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    rpc.request = async (method, params) => {
      const response = await original(method, params);
      if (method === phase && !held) { held = true; reached(); await blocked; }
      return response;
    };
    const running = collect(client.run("existing", "Do not send", undefined, { todoMcp: configuration() }));
    await started;
    await expect(collect(client.run("existing", "Concurrent send"))).rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });
    await client.abort("existing");
    release();
    expect(await running).toEqual([{ type: "turn_aborted" }]);
    expect(rpc.sentConfigurations).toEqual([]);
    expect(rpc.calls.some(call => call.method === "session/send" || call.method === "session/stop")).toBe(false);
    if (phase === "session/close") expect(rpc.calls.some(call => call.method === "session/resume")).toBe(false);
    if (phase === "session/resume") expect(rpc.calls.some(call => call.method === "session/subscribe")).toBe(false);
    await collect(client.run("existing", "Retry", undefined, { todoMcp: configuration() }));
    expect(rpc.sentConfigurations).toEqual([expectedServers()]);
  });

  it("does not recover an evicted Todo resident after a stop during subscribe", async () => {
    const rpc = new TodoRpc();
    const client = clientFor(rpc);
    const original = rpc.request.bind(rpc);
    let reached!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    rpc.request = async (method, params) => {
      if (method === "session/subscribe") {
        reached(); await blocked;
        throw new NativeRpcError("Session is not active: existing", -32004);
      }
      return original(method, params);
    };
    const running = collect(client.run("existing", "Do not send", undefined, { todoMcp: configuration() }));
    await started;
    await client.abort("existing");
    release();
    expect(await running).toEqual([{ type: "turn_aborted" }]);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
    expect(rpc.sentConfigurations).toEqual([]);
  });

  it("does not mutate or steer an external owner's runtime when Todo injection is requested", async () => {
    const rpc = new TodoRpc();
    const client = new ZCodeClient(rpc, { readMany: async () => new Map([["existing", true]]) }, { available: async () => true, steer: async () => { throw new Error("must not steer"); } });
    await expect(collect(client.run("existing", "Task", undefined, { todoMcp: configuration() }))).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect(rpc.calls.some(call => ["session/close", "session/resume", "session/subscribe", "session/send"].includes(call.method))).toBe(false);
  });

  it("keeps each session's descriptor isolated and restores the configuration after idle eviction", async () => {
    const rpc = new TodoRpc();
    const client = clientFor(rpc);
    await collect(client.run("existing", "Task A", undefined, { todoMcp: configuration() }));
    await collect(client.run("other", "Task B", undefined, { todoMcp: configuration("b") }));
    rpc.evictOnSubscribe = true;
    await collect(client.run("existing", "Task A again", undefined, { todoMcp: configuration() }));
    expect(rpc.sentConfigurations).toEqual([expectedServers(), expectedServers("b"), expectedServers()]);
    expect(rpc.calls.filter(call => call.method === "session/resume").at(-1)?.params).toEqual({ sessionId: "existing", mcpServers: expectedServers() });
    expect(rpc.calls.every(call => call.method.startsWith("session/"))).toBe(true);
  });
});

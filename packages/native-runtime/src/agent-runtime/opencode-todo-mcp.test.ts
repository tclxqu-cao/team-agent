import { describe, expect, it, vi } from "vitest";
import type { OpencodeClient, Session } from "@opencode-ai/sdk";
import { OpenCodeRuntimeAdapter, type OpenCodeServerPort } from "./opencode-runtime-adapter";
import { openCodeTodoConfig, type OpenCodeServerEvent } from "./opencode-server-client";
import type { NativeTodoMcpConfiguration } from "./runtime-tool-injection";

function fixture() {
  let listener: ((event: OpenCodeServerEvent) => void) | undefined;
  const session: Session = { id: "session", projectID: "project", directory: "/workspace", title: "Task", version: "2", time: { created: 1, updated: 1 } };
  const client = { project: { list: vi.fn(async () => ({ data: [{ id: "project", worktree: "/workspace", time: { created: 1 } }] })) },
    session: {
      get: vi.fn(async ({ path }: { path: { id: string } }) => ({ data: { ...session, id: path.id } })),
      list: vi.fn(async () => ({ data: [session, { ...session, id: "first" }, { ...session, id: "second" }] })), status: vi.fn(async () => ({ data: {} })),
      create: vi.fn(async () => ({ data: session })), messages: vi.fn(async () => ({ data: [] })),
      promptAsync: vi.fn(async () => ({ data: undefined })), abort: vi.fn(async () => ({ data: true })),
    },
  };
  const ready = vi.fn(async (): Promise<void> => undefined);
  const server: OpenCodeServerPort = { client: async () => client as unknown as OpencodeClient,
    waitForTodoMcp: ready, subscribe: next => { listener = next; return () => { listener = undefined; }; }, dispose: vi.fn(async () => undefined) };
  return { client, server, ready, finish(id = "session") { listener?.({ directory: "/workspace", payload: { type: "session.idle", properties: { sessionID: id } } }); } };
}
async function drain(events: AsyncIterable<unknown>) { const result = []; for await (const event of events) result.push(event); return result; }
const config: NativeTodoMcpConfiguration = { command: "node", args: ["--mcp"], env: { AGENTROAM_TODO_DESCRIPTOR: "/credentials/scoped.json" } };

describe("OpenCode isolated Todo MCP", () => {
  it.each([
    { command: "C:\\Program Files\\nodejs\\node.exe", args: ["D:\\Agent Data\\todo.mjs", "literal $arg"], env: { AGENTROAM_TODO_DESCRIPTOR: "C:\\Users\\Other User\\todo.json" } },
    { command: "/opt/custom runtime/node", args: ["/srv/agent data/todo.mjs", "literal $(arg)"], env: { AGENTROAM_TODO_DESCRIPTOR: "/var/custom root/todo.json" } },
  ])("passes dynamic command, args and credentials without shell interpolation: %j", configuration => {
    const original = { providers: { kept: {} }, mcp: { servers: { existing: { type: "remote", url: "https://example.test" } } } };
    const output = JSON.parse(openCodeTodoConfig(JSON.stringify(original), configuration, true)!);
    expect(output.providers).toEqual(original.providers);
    expect(output.mcp.servers.existing).toEqual(original.mcp.servers.existing);
    expect(output.mcp.servers["agentroam-todo"]).toEqual({ type: "local", command: [configuration.command, ...configuration.args], environment: configuration.env, disabled: false, pool: false });
  });

  it("keeps legacy process config and never mutates its input", () => {
    const original = JSON.stringify({ permission: { edit: "ask" }, mcp: { other: {} } });
    const output = JSON.parse(openCodeTodoConfig(original, config, false)!);
    expect(output.permission).toEqual({ edit: "ask" });
    expect(output.mcp.other).toEqual({});
    expect(output.mcp["agentroam-todo"].enabled).toBe(true);
    expect(openCodeTodoConfig(original, undefined, false)).toBe(original);
  });

  it("retains create-time tools and sends only after the isolated host connects", async () => {
    const shared = fixture(), isolated = fixture();
    const factory = vi.fn(() => isolated.server);
    const adapter = new OpenCodeRuntimeAdapter({ server: shared.server, todoServerFactory: factory });
    await adapter.create({ title: "Task", cwd: "/workspace", todoMcp: config });
    const completed = drain(adapter.run("session", "create my todo"));
    await vi.waitFor(() => expect(isolated.client.session.promptAsync).toHaveBeenCalledOnce());
    expect(factory).toHaveBeenCalledWith(config);
    expect(isolated.ready).toHaveBeenCalledWith("/workspace", expect.any(AbortSignal));
    expect(shared.client.session.promptAsync).not.toHaveBeenCalled();
    await expect(adapter.steer("session", "more")).resolves.toBe(true);
    expect(isolated.client.session.promptAsync).toHaveBeenCalledTimes(2);
    isolated.finish(); await completed;
    expect(isolated.server.dispose).toHaveBeenCalledOnce();
    expect(shared.server.dispose).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  it("isolates two credentials in the same workspace and closes each host", async () => {
    const shared = fixture(), first = fixture(), second = fixture();
    const factory = vi.fn().mockReturnValueOnce(first.server).mockReturnValueOnce(second.server);
    const adapter = new OpenCodeRuntimeAdapter({ server: shared.server, todoServerFactory: factory });
    const other = { ...config, env: { AGENTROAM_TODO_DESCRIPTOR: "/another-owner/credentials.json" } };
    const a = drain(adapter.run("first", "a", undefined, undefined, undefined, { todoMcp: config }));
    const b = drain(adapter.run("second", "b", undefined, undefined, undefined, { todoMcp: other }));
    await vi.waitFor(() => expect(second.client.session.promptAsync).toHaveBeenCalledOnce());
    expect(factory.mock.calls.map(([configuration]) => configuration)).toEqual([config, other]);
    expect(shared.client.session.promptAsync).not.toHaveBeenCalled();
    first.finish("first"); second.finish("second"); await Promise.all([a, b]);
    expect(first.server.dispose).toHaveBeenCalledOnce(); expect(second.server.dispose).toHaveBeenCalledOnce();
    await adapter.dispose();
  });

  it("does not send a user turn when isolated MCP initialization fails", async () => {
    const shared = fixture(), isolated = fixture();
    isolated.ready.mockRejectedValueOnce(new Error("Todo MCP connection failed"));
    const adapter = new OpenCodeRuntimeAdapter({ server: shared.server, todoServerFactory: () => isolated.server });
    await expect(drain(adapter.run("session", "must not send", undefined, undefined, undefined, { todoMcp: config }))).rejects.toThrow("Todo MCP connection failed");
    expect(isolated.client.session.promptAsync).not.toHaveBeenCalled();
    expect(isolated.server.dispose).toHaveBeenCalledOnce();
    await adapter.dispose();
  });

  it("rejects another admission of the same session before starting a second host", async () => {
    const shared = fixture(), isolated = fixture();
    let release!: () => void;
    isolated.ready.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const factory = vi.fn(() => isolated.server);
    const adapter = new OpenCodeRuntimeAdapter({ server: shared.server, todoServerFactory: factory });
    const first = drain(adapter.run("session", "first", undefined, undefined, undefined, { todoMcp: config }));
    await vi.waitFor(() => expect(isolated.ready).toHaveBeenCalled());
    await expect(drain(adapter.run("session", "second", undefined, undefined, undefined, { todoMcp: config })))
      .rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });
    expect(factory).toHaveBeenCalledOnce();
    release(); await vi.waitFor(() => expect(isolated.client.session.promptAsync).toHaveBeenCalled());
    isolated.finish(); await first; await adapter.dispose();
  });

  it("does not send after cancellation during the MCP handshake", async () => {
    const shared = fixture(), isolated = fixture();
    let release!: () => void;
    isolated.ready.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const adapter = new OpenCodeRuntimeAdapter({ server: shared.server, todoServerFactory: () => isolated.server });
    const run = drain(adapter.run("session", "must not send", undefined, undefined, undefined, { todoMcp: config }));
    await vi.waitFor(() => expect(isolated.ready).toHaveBeenCalled());
    await adapter.abort("session"); release();
    expect(await run).toEqual([{ type: "turn_aborted" }]);
    expect(isolated.client.session.promptAsync).not.toHaveBeenCalled();
    expect(isolated.server.dispose).toHaveBeenCalledOnce();
    await adapter.dispose();
  });

  it("ends an owned run and its queue when the parent adapter is disposed", async () => {
    const shared = fixture(), isolated = fixture();
    const adapter = new OpenCodeRuntimeAdapter({ server: shared.server, todoServerFactory: () => isolated.server });
    const run = drain(adapter.run("session", "start", undefined, undefined, undefined, { todoMcp: config }));
    await vi.waitFor(() => expect(isolated.client.session.promptAsync).toHaveBeenCalled());
    await adapter.dispose();
    expect(await run).toContainEqual({ type: "turn_aborted" });
    expect(isolated.server.dispose).toHaveBeenCalledOnce();
  });

  it.each([true, false])("reserves the session across plain and Todo admissions (Todo first: %s)", async todoFirst => {
    const shared = fixture(), isolated = fixture();
    let release!: () => void;
    shared.client.session.get.mockImplementationOnce(({ path }) => new Promise(resolve => {
      release = () => resolve({ data: { id: path.id, projectID: "project", directory: "/workspace", title: "Task", version: "2", time: { created: 1, updated: 1 } } });
    }));
    const factory = vi.fn(() => isolated.server);
    const adapter = new OpenCodeRuntimeAdapter({ server: shared.server, todoServerFactory: factory });
    const first = drain(adapter.run("session", "first", undefined, undefined, undefined, todoFirst ? { todoMcp: config } : undefined));
    await vi.waitFor(() => expect(shared.client.session.get).toHaveBeenCalled());
    await expect(drain(adapter.run("session", "second", undefined, undefined, undefined, todoFirst ? undefined : { todoMcp: config })))
      .rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });
    release();
    const active = todoFirst ? isolated : shared;
    await vi.waitFor(() => expect(active.client.session.promptAsync).toHaveBeenCalledOnce());
    active.finish(); await first; await adapter.dispose();
  });

  it("does not send after cancellation while the isolated adapter reads the session", async () => {
    const shared = fixture(), isolated = fixture();
    let release!: () => void;
    isolated.client.session.get.mockImplementationOnce(({ path }) => new Promise(resolve => {
      release = () => resolve({ data: { id: path.id, projectID: "project", directory: "/workspace", title: "Task", version: "2", time: { created: 1, updated: 1 } } });
    }));
    const adapter = new OpenCodeRuntimeAdapter({ server: shared.server, todoServerFactory: () => isolated.server });
    const run = drain(adapter.run("session", "must not send", undefined, undefined, undefined, { todoMcp: config }));
    await vi.waitFor(() => expect(isolated.client.session.get).toHaveBeenCalled());
    await adapter.abort("session"); release();
    expect(await run).toEqual([{ type: "turn_aborted" }]);
    expect(isolated.client.session.promptAsync).not.toHaveBeenCalled();
    expect(shared.client.session.abort).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  it("rechecks shared-host occupancy after the MCP handshake", async () => {
    const shared = fixture(), isolated = fixture();
    isolated.ready.mockImplementationOnce(async () => {
      Object.assign(shared.client.session, { status: vi.fn(async () => ({ data: { session: { type: "busy" } } })) });
    });
    const adapter = new OpenCodeRuntimeAdapter({ server: shared.server, todoServerFactory: () => isolated.server });
    await expect(drain(adapter.run("session", "must not send", undefined, undefined, undefined, { todoMcp: config })))
      .rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    expect(isolated.client.session.promptAsync).not.toHaveBeenCalled();
    expect(shared.client.session.abort).not.toHaveBeenCalled();
    expect(isolated.server.dispose).toHaveBeenCalledOnce();
    await adapter.dispose();
  });

  it("retains admission until the old isolated host has finished closing", async () => {
    const shared = fixture(), isolated = fixture();
    let release!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    isolated.server.dispose = close;
    const adapter = new OpenCodeRuntimeAdapter({ server: shared.server, todoServerFactory: () => isolated.server });
    const run = drain(adapter.run("session", "first", undefined, undefined, undefined, { todoMcp: config }));
    await vi.waitFor(() => expect(isolated.client.session.promptAsync).toHaveBeenCalledOnce());
    isolated.finish();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await expect(drain(adapter.run("session", "second"))).rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });
    release(); await run; await adapter.dispose();
  });
});

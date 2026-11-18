import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalEvent, OpencodeClient } from "@opencode-ai/sdk";
import {
  OpenCodeServerClient,
  subscribeToOpenCodeEvents,
} from "./opencode-server-client.js";

const nativeProcess = vi.hoisted(() => ({
  version: undefined as ((signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>) | undefined,
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(actual.execFile);
  const wrappedExecFile = (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args);
  Object.defineProperty(wrappedExecFile, promisify.custom, { value: async (
    file: string, args: string[], options: import("node:child_process").ExecFileOptions,
  ) => {
    if (file === "opencode-lifecycle-fixture") {
      if (!nativeProcess.version) throw new Error("Missing lifecycle fixture");
      return nativeProcess.version(options.signal);
    }
    return run(file, args, options);
  } });
  return { ...actual, execFile: wrappedExecFile, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (args[0] === "opencode-lifecycle-fixture") {
      nativeProcess.spawn();
      throw new Error("Disposed lifecycle fixture must not spawn a host");
    }
    return actual.spawn(...args);
  } };
});

afterEach(() => {
  nativeProcess.version = undefined;
  nativeProcess.spawn.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const connectedEvent = {
  directory: "/repo",
  payload: { type: "server.connected", properties: {} },
} as GlobalEvent;

const idleEvent = {
  directory: "/repo",
  payload: { type: "session.idle", properties: { sessionID: "ses_1" } },
} as GlobalEvent;

function eventClient(...streams: AsyncIterable<GlobalEvent>[]) {
  const event = vi.fn(async () => ({ stream: streams.shift()! }));
  return {
    client: { global: { event } } as unknown as OpencodeClient,
    event,
  };
}

async function* events(...values: GlobalEvent[]): AsyncGenerator<GlobalEvent> {
  for (const value of values) yield value;
}

describe("OpenCodeServerClient", () => {
  it("does not spawn a host when disposed during the version lookup", async () => {
    let release!: (version: { stdout: string; stderr: string }) => void;
    let signal: AbortSignal | undefined;
    nativeProcess.version = incoming => {
      signal = incoming;
      return new Promise(resolve => { release = resolve; });
    };
    const server = new OpenCodeServerClient({ executable: "opencode-lifecycle-fixture" });
    const starting = server.client();
    await server.dispose();
    expect(signal?.aborted).toBe(true);
    release({ stdout: "opencode v2.3.0", stderr: "" });
    await expect(starting).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(nativeProcess.spawn).not.toHaveBeenCalled();
    await expect(server.client()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it.each([
    { v2: true, directory: "D:\\Workspaces\\Other Project", query: "location[directory]", path: "/api/mcp" },
    { v2: false, directory: "/srv/another project", query: "directory", path: "/mcp" },
  ])("verifies Todo MCP in the requested native location: $query", async ({ v2, directory, query, path }) => {
    const server = new OpenCodeServerClient({ todoMcp: { command: "node", args: ["todo.mjs"], env: {} } });
    vi.spyOn(server, "client").mockResolvedValue({} as never);
    Object.assign(server, { connection: { url: "http://127.0.0.1:12345", v2 } });
    const fetcher = vi.fn(async (input: URL) => {
      expect(input.pathname).toBe(path);
      expect(input.searchParams.get(query)).toBe(directory);
      expect(input.searchParams.has(v2 ? "directory" : "location[directory]")).toBe(false);
      return Response.json(v2 ? { data: [{ name: "agentroam-todo", status: { status: "connected" } }] }
        : { "agentroam-todo": { status: "connected" } });
    });
    vi.stubGlobal("fetch", fetcher);
    await server.waitForTodoMcp(directory);
    expect(fetcher).toHaveBeenCalledOnce();
    await server.dispose();
  });

  it("does not discover MCP after cancellation while its client is starting", async () => {
    const server = new OpenCodeServerClient({ todoMcp: { command: "node", args: ["todo.mjs"], env: {} } });
    let release!: () => void;
    vi.spyOn(server, "client").mockImplementation(() => new Promise(resolve => { release = () => resolve({} as never); }));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const pending = server.waitForTodoMcp("/workspace", controller.signal);
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    await server.dispose();
  });

  it("reports a missing executable without waiting for the health timeout", async () => {
    const client = new OpenCodeServerClient({ executable: "/definitely/missing/agentroam-opencode" });
    const started = Date.now();
    await expect(client.client()).rejects.toThrow(/ENOENT|missing/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    await client.dispose();
  });

  it("isolates a malformed event handler failure and keeps consuming the stream", async () => {
    const fixture = eventClient(events(connectedEvent, idleEvent));
    const received: GlobalEvent[] = [];
    const eventErrors: Error[] = [];
    const stop = subscribeToOpenCodeEvents(fixture.client, {
      onEvent: (event) => {
        if (event === connectedEvent) throw new Error("malformed event");
        received.push(event);
      },
      onEventError: (error) => eventErrors.push(error),
      onFailure: vi.fn(),
    });

    await vi.waitFor(() => expect(received).toEqual([idleEvent]));
    expect(eventErrors[0]?.message).toBe("malformed event");
    expect(fixture.event).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reconnects after the global event stream ends unexpectedly", async () => {
    let releaseSecondStream!: () => void;
    async function* secondStream(): AsyncGenerator<GlobalEvent> {
      yield idleEvent;
      await new Promise<void>((resolve) => { releaseSecondStream = resolve; });
    }
    const fixture = eventClient(events(connectedEvent), secondStream());
    const received: GlobalEvent[] = [];
    const failures: Error[] = [];
    const stop = subscribeToOpenCodeEvents(fixture.client, {
      onEvent: (event) => received.push(event),
      onEventError: vi.fn(),
      onFailure: (error) => failures.push(error),
      reconnectDelayMs: () => 0,
    });

    await vi.waitFor(() => expect(received).toEqual([connectedEvent, idleEvent]));
    expect(fixture.event).toHaveBeenCalledTimes(2);
    expect(failures[0]?.message).toBe("OpenCode event stream ended unexpectedly");
    stop();
    releaseSecondStream();
  });
});

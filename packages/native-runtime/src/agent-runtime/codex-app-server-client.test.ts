import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerLauncher } from "./codex-app-server-launcher.js";
import { CodexAppServerClient, normalizeCodexEnvironment } from "./codex-app-server-client.js";

type FakeProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  pid: number | undefined;
  killSignals: string[];
  kill(signal?: string): boolean;
};

function fakeProcess(pid = 4242): FakeProcess {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    pid: number | undefined;
    killSignals: string[];
    kill(signal?: string): boolean;
  };
  emitter.stdin = new PassThrough();
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.killed = false;
  emitter.pid = pid;
  emitter.killSignals = [];
  emitter.kill = (signal = "SIGTERM") => {
    emitter.killSignals.push(signal);
    emitter.killed = true;
    queueMicrotask(() => emitter.emit("exit", 0, "SIGTERM"));
    return true;
  };
  return emitter;
}

function launcherFor(child: FakeProcess): CodexAppServerLauncher {
  return {
    attempts: () => [{ mode: "standalone", launch: async () => child as never }],
  };
}

function handleJsonRpc(
  child: FakeProcess,
  options: {
    initializeError?: string;
    responses?: Record<string, unknown>;
  } = {},
): void {
  let input = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    input += chunk;
    let newline = input.indexOf("\n");
    while (newline >= 0) {
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (line) {
        const request = JSON.parse(line) as { id?: number; method: string };
        respondToRpc(request, options, (response) => {
          child.stdout.write(`${JSON.stringify(response)}\n`);
        });
      }
      newline = input.indexOf("\n");
    }
  });
}

function handleWebSocketJsonRpc(
  child: FakeProcess,
  options: {
    initializeError?: string;
    responses?: Record<string, unknown>;
  } = {},
): void {
  let input = Buffer.alloc(0);
  let upgraded = false;
  child.stdin.on("data", (chunk: Buffer | string) => {
    input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (!upgraded) {
      const headerEnd = input.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headers = input.subarray(0, headerEnd).toString("utf8");
      const key = /^sec-websocket-key:\s*(.+)$/im.exec(headers)?.[1]?.trim();
      if (!key) throw new Error("Missing Sec-WebSocket-Key");
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      child.stdout.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"));
      input = input.subarray(headerEnd + 4);
      upgraded = true;
    }

    while (input.length >= 2) {
      const opcode = input[0]! & 0x0f;
      const masked = (input[1]! & 0x80) !== 0;
      let payloadLength = input[1]! & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (input.length < 4) return;
        payloadLength = input.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        throw new Error("Test WebSocket payload exceeds supported size");
      }
      const maskLength = masked ? 4 : 0;
      if (input.length < offset + maskLength + payloadLength) return;
      const mask = masked ? input.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(input.subarray(offset, offset + payloadLength));
      input = input.subarray(offset + payloadLength);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
      }
      if (opcode !== 0x1) continue;
      const request = JSON.parse(payload.toString("utf8")) as { id?: number; method: string };
      respondToRpc(request, options, (response) => writeWebSocketJson(child, response));
    }
  });
}

function respondToRpc(
  request: { id?: number; method: string },
  options: { initializeError?: string; responses?: Record<string, unknown> },
  write: (response: unknown) => void,
): void {
  if (request.id !== undefined && request.method === "initialize") {
    write(options.initializeError
      ? { id: request.id, error: { code: -32_000, message: options.initializeError } }
      : { id: request.id, result: {} });
  } else if (request.id !== undefined && request.method in (options.responses ?? {})) {
    write({ id: request.id, result: options.responses?.[request.method] });
  }
}

function writeWebSocketJson(child: FakeProcess, message: unknown): void {
  const payload = Buffer.from(JSON.stringify(message));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  child.stdout.write(Buffer.concat([header, payload]));
}

describe("CodexAppServerClient", () => {
  it("handles fragmented JSON lines and correlates requests", async () => {
    const child = fakeProcess();
    let input = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => {
      input += chunk;
      let newline = input.indexOf("\n");
      while (newline >= 0) {
        const request = JSON.parse(input.slice(0, newline)) as { id?: number; method: string };
        input = input.slice(newline + 1);
        if (request.method === "initialize") {
          child.stdout.write(`{"id":${request.id},"res`);
          child.stdout.write('ult":{}}\n');
        } else if (request.method === "thread/list") {
          child.stdout.write(`${JSON.stringify({ id: request.id, result: { data: ["ok"], nextCursor: null } })}\n`);
        }
        newline = input.indexOf("\n");
      }
    });
    const client = new CodexAppServerClient({
      launcher: launcherFor(child),
      requestTimeoutMs: 1000,
    });

    await expect(client.request("thread/list", {})).resolves.toEqual({ data: ["ok"], nextCursor: null });
    expect(client.pid).toBe(4242);
    expect(client.mode).toBe("standalone");
    await client.dispose();
    expect(client.mode).toBeNull();
  });

  it("normalizes wildcard NO_PROXY rules for the Rust Codex process", () => {
    const environment = normalizeCodexEnvironment({
      HTTP_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,*.gptdy.17usoft.com,*17usoft.com:8443",
      no_proxy: "*.example.com",
    });

    expect(environment.NO_PROXY).toContain(".gptdy.17usoft.com");
    expect(environment.NO_PROXY).toContain("gptdy.17usoft.com");
    expect(environment.NO_PROXY).toContain("17usoft.com:8443");
    expect(environment.NO_PROXY).toContain(".17usoft.com:8443");
    expect(environment.no_proxy).toBe(environment.NO_PROXY);
    expect(environment.no_proxy).toContain(".example.com");
    expect(environment.no_proxy).toContain("example.com");
  });

  it("delivers notifications and rejects pending calls after exit", async () => {
    const child = fakeProcess();
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => {
      const request = JSON.parse(chunk.trim()) as { id?: number; method: string };
      if (request.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    });
    const client = new CodexAppServerClient({
      launcher: launcherFor(child),
      requestTimeoutMs: 1000,
    });
    const notifications: string[] = [];
    client.onNotification((message) => notifications.push(message.method));
    const pending = client.request("thread/read", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.stdout.write('{"method":"turn/started","params":{}}\n');
    child.emit("exit", 1, null);

    await expect(pending).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(notifications).toEqual(["turn/started"]);
    expect(client.mode).toBeNull();
  });

  it("starts the shared daemon before proxying JSON-RPC by default", async () => {
    const daemon = fakeProcess(1001);
    const proxy = fakeProcess(1002);
    handleWebSocketJsonRpc(proxy, {
      responses: { "thread/list": { data: ["shared"], nextCursor: null } },
    });
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const spawnProcess = vi.fn((_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args: [...args], env: options.env });
      if (args.join(" ") === "app-server daemon start") {
        queueMicrotask(() => daemon.emit("exit", 0, null));
        return daemon;
      }
      return proxy;
    });
    const client = new CodexAppServerClient({
      spawnProcess: spawnProcess as never,
      environment: { NO_PROXY: "*.gptdy.17usoft.com" },
      requestTimeoutMs: 1000,
    });

    await expect(client.request("thread/list", {})).resolves.toEqual({ data: ["shared"], nextCursor: null });
    expect(calls.map(({ args }) => args)).toEqual([
      ["app-server", "daemon", "start"],
      ["app-server", "proxy"],
    ]);
    expect(calls[0]?.env?.NO_PROXY).toContain(".gptdy.17usoft.com");
    expect(client.pid).toBe(1002);
    expect(client.mode).toBe("shared");

    await client.dispose();
    expect(client.mode).toBeNull();
    expect(proxy.killSignals).toEqual(["SIGTERM"]);
    expect(calls).toHaveLength(2);
  });

  it("falls back to standalone when daemon startup is unsupported", async () => {
    const daemon = fakeProcess(2001);
    const standalone = fakeProcess(2002);
    handleJsonRpc(standalone, {
      responses: { "thread/list": { data: ["standalone"], nextCursor: null } },
    });
    const calls: string[][] = [];
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args.join(" ") === "app-server daemon start") {
        queueMicrotask(() => {
          daemon.stderr.write("unknown subcommand 'daemon'");
          daemon.emit("exit", 2, null);
        });
        return daemon;
      }
      return standalone;
    });
    const client = new CodexAppServerClient({
      spawnProcess: spawnProcess as never,
      requestTimeoutMs: 1000,
    });
    const onExit = vi.fn();
    client.onExit(onExit);

    await expect(client.request("thread/list", {})).resolves.toEqual({ data: ["standalone"], nextCursor: null });
    expect(calls).toEqual([
      ["app-server", "daemon", "start"],
      ["app-server", "--stdio"],
    ]);
    expect(client.mode).toBe("standalone");
    expect(onExit).not.toHaveBeenCalled();
    await client.dispose();
  });

  it("falls back to standalone when daemon startup times out", async () => {
    const daemon = fakeProcess(3001);
    const standalone = fakeProcess(3002);
    handleJsonRpc(standalone, {
      responses: { "thread/list": { data: ["timeout-fallback"], nextCursor: null } },
    });
    const calls: string[][] = [];
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return args.join(" ") === "app-server daemon start" ? daemon : standalone;
    });
    const client = new CodexAppServerClient({
      spawnProcess: spawnProcess as never,
      requestTimeoutMs: 1000,
      startupTimeoutMs: 5,
    });

    await expect(client.request("thread/list", {})).resolves.toEqual({
      data: ["timeout-fallback"],
      nextCursor: null,
    });
    expect(daemon.killSignals).toEqual(["SIGTERM"]);
    expect(calls).toEqual([
      ["app-server", "daemon", "start"],
      ["app-server", "--stdio"],
    ]);
    await client.dispose();
  });

  it("falls back when the proxy exits before the client can attach", async () => {
    const daemon = fakeProcess(3501);
    const proxy = fakeProcess(3502);
    const standalone = fakeProcess(3503);
    handleJsonRpc(standalone, {
      responses: { "thread/list": { data: ["early-exit-fallback"], nextCursor: null } },
    });
    const calls: string[][] = [];
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      calls.push([...args]);
      const command = args.join(" ");
      if (command === "app-server daemon start") {
        queueMicrotask(() => daemon.emit("exit", 0, null));
        return daemon;
      }
      if (command === "app-server proxy") {
        queueMicrotask(() => proxy.emit("exit", 7, null));
        return proxy;
      }
      return standalone;
    });
    const client = new CodexAppServerClient({
      spawnProcess: spawnProcess as never,
      requestTimeoutMs: 1000,
    });

    await expect(client.request("thread/list", {})).resolves.toEqual({
      data: ["early-exit-fallback"],
      nextCursor: null,
    });
    expect(calls).toEqual([
      ["app-server", "daemon", "start"],
      ["app-server", "proxy"],
      ["app-server", "--stdio"],
    ]);
    await client.dispose();
  });

  it("falls back when the proxy WebSocket handshake times out", async () => {
    const daemon = fakeProcess(3601);
    const proxy = fakeProcess(3602);
    const standalone = fakeProcess(3603);
    handleJsonRpc(standalone, {
      responses: { "thread/list": { data: ["handshake-fallback"], nextCursor: null } },
    });
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      const command = args.join(" ");
      if (command === "app-server daemon start") {
        queueMicrotask(() => daemon.emit("exit", 0, null));
        return daemon;
      }
      return command === "app-server proxy" ? proxy : standalone;
    });
    const client = new CodexAppServerClient({
      spawnProcess: spawnProcess as never,
      requestTimeoutMs: 1000,
      startupTimeoutMs: 5,
    });

    await expect(client.request("thread/list", {})).resolves.toEqual({
      data: ["handshake-fallback"],
      nextCursor: null,
    });
    expect(proxy.killSignals).toEqual(["SIGTERM"]);
    await client.dispose();
  });

  it("cleans up a proxy that fails initialization before falling back", async () => {
    const daemon = fakeProcess(4001);
    const proxy = fakeProcess(4002);
    const standalone = fakeProcess(4003);
    handleWebSocketJsonRpc(proxy, { initializeError: "proxy initialization failed" });
    handleJsonRpc(standalone, {
      responses: { "thread/list": { data: ["fallback"], nextCursor: null } },
    });
    const calls: string[][] = [];
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      calls.push([...args]);
      const command = args.join(" ");
      if (command === "app-server daemon start") {
        queueMicrotask(() => daemon.emit("exit", 0, null));
        return daemon;
      }
      if (command === "app-server proxy") return proxy;
      return standalone;
    });
    const client = new CodexAppServerClient({
      spawnProcess: spawnProcess as never,
      requestTimeoutMs: 1000,
    });
    const onExit = vi.fn();
    client.onExit(onExit);

    await expect(client.request("thread/list", {})).resolves.toEqual({ data: ["fallback"], nextCursor: null });
    expect(calls).toEqual([
      ["app-server", "daemon", "start"],
      ["app-server", "proxy"],
      ["app-server", "--stdio"],
    ]);
    expect(proxy.killSignals).toEqual(["SIGTERM"]);
    expect(onExit).not.toHaveBeenCalled();
    await client.dispose();
  });

  it("probes shared mode again after a standalone connection restarts", async () => {
    const firstDaemon = fakeProcess(5001);
    const standalone = fakeProcess(5002);
    const secondDaemon = fakeProcess(5003);
    const proxy = fakeProcess(5004);
    handleJsonRpc(standalone, {
      responses: { "thread/list": { data: ["standalone"], nextCursor: null } },
    });
    handleWebSocketJsonRpc(proxy);
    const children = [firstDaemon, standalone, secondDaemon, proxy];
    const calls: string[][] = [];
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      calls.push([...args]);
      const child = children.shift();
      if (!child) throw new Error("Unexpected spawn");
      if (child === firstDaemon) queueMicrotask(() => child.emit("exit", 2, null));
      if (child === secondDaemon) queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    });
    const client = new CodexAppServerClient({
      spawnProcess: spawnProcess as never,
      requestTimeoutMs: 1000,
    });

    await expect(client.request("thread/list", {})).resolves.toEqual({ data: ["standalone"], nextCursor: null });
    expect(client.mode).toBe("standalone");
    await client.restart();

    expect(calls).toEqual([
      ["app-server", "daemon", "start"],
      ["app-server", "--stdio"],
      ["app-server", "daemon", "start"],
      ["app-server", "proxy"],
    ]);
    expect(client.pid).toBe(5004);
    expect(client.mode).toBe("shared");
    await client.dispose();
  });

  it("rejects when both shared and standalone startup fail", async () => {
    const daemon = fakeProcess(6001);
    const standalone = fakeProcess(6002);
    standalone.pid = undefined;
    const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
      if (args.join(" ") === "app-server daemon start") {
        queueMicrotask(() => daemon.emit("exit", 2, null));
        return daemon;
      }
      queueMicrotask(() => standalone.emit("error", new Error("standalone spawn failed")));
      return standalone;
    });
    const client = new CodexAppServerClient({
      spawnProcess: spawnProcess as never,
      requestTimeoutMs: 1000,
    });
    const onExit = vi.fn();
    client.onExit(onExit);

    await expect(client.request("thread/list", {})).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      message: "standalone spawn failed",
    });
    expect(onExit).not.toHaveBeenCalled();
    await client.dispose();
  });
});

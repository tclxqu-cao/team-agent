import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./codex-app-server-client.js";

function fakeProcess() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    pid: number;
    kill(signal?: string): boolean;
  };
  emitter.stdin = new PassThrough();
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.killed = false;
  emitter.pid = 4242;
  emitter.kill = () => {
    emitter.killed = true;
    queueMicrotask(() => emitter.emit("exit", 0, "SIGTERM"));
    return true;
  };
  return emitter;
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
      spawnProcess: vi.fn(() => child) as never,
      requestTimeoutMs: 1000,
    });

    await expect(client.request("thread/list", {})).resolves.toEqual({ data: ["ok"], nextCursor: null });
    expect(client.pid).toBe(4242);
    await client.dispose();
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
      spawnProcess: vi.fn(() => child) as never,
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
  });
});

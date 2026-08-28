import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { PinggyTunnelProvider, parsePinggyUrl } from "./pinggy-provider.js";

describe("parsePinggyUrl", () => {
  it("accepts only Pinggy free HTTPS URLs", () => {
    expect(parsePinggyUrl("open https://abc-123.run.pinggy-free.link now")).toBe(
      "https://abc-123.run.pinggy-free.link",
    );
    expect(parsePinggyUrl("https://example.com")).toBeNull();
    expect(parsePinggyUrl("http://abc.run.pinggy-free.link")).toBeNull();
  });
});

describe("PinggyTunnelProvider", () => {
  it("starts SSH on port 443 with persistent host-key checking", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn((_command: string, _args: readonly string[]) => child as never);
    const provider = new PinggyTunnelProvider(43210, "/tmp/agentroam-test", spawnImpl as never);
    const started = provider.start({ localUrl: "http://127.0.0.1:43210", signal: new AbortController().signal, log: vi.fn() });
    queueMicrotask(() => child.stderr.write("https://sample.run.pinggy-free.link\n"));
    const handle = await started;

    expect(handle.publicUrl).toBe("https://sample.run.pinggy-free.link");
    const args = spawnImpl.mock.calls[0][1] as string[];
    expect(args).toContain("443");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args).toContain("0:localhost:43210");
    expect(args.some((value) => value.startsWith("UserKnownHostsFile="))).toBe(true);
  });
});

function fakeChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  Object.defineProperty(child, "exitCode", { value: null, writable: true });
  Object.defineProperty(child, "pid", { value: undefined, writable: true });
  child.kill = vi.fn(() => {
    (child as { exitCode: number | null }).exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}

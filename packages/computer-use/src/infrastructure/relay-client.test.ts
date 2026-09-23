import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { ComputerRelayClient } from "./relay-client.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(
  handler: (request: Record<string, unknown>) => Record<string, unknown> | string,
  timeoutMs = 1_000,
): Promise<{ client: ComputerRelayClient; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "computer-relay-client-"));
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o700);
  const path = join(directory, "relay.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      const response = handler(request);
      socket.write(typeof response === "string" ? response : `${JSON.stringify(response)}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.listen(path, resolve).once("error", reject));
  return { client: new ComputerRelayClient({ socketPath: path, timeoutMs }), path };
}

describe("ComputerRelayClient", () => {
  it("round-trips status and actions with request IDs", async () => {
    const seen: Record<string, unknown>[] = [];
    const { client } = await fixture((request) => {
      seen.push(request);
      return request.type === "status"
        ? { id: request.id, ok: true, result: { available: true, platform: "darwin", protocolVersion: 1 } }
        : { id: request.id, ok: true, result: { source: "accessibility", revision: "ax_1", coverage: "complete", app: { name: "Fixture", bundleId: "dev.fixture", pid: 1 }, nodes: [] } };
    });
    expect(await client.status()).toMatchObject({ available: true, platform: "darwin" });
    expect(await client.execute({ action: "observe" })).toMatchObject({ source: "accessibility", revision: "ax_1" });
    expect(seen).toEqual([
      expect.objectContaining({ type: "status", version: 1, id: expect.any(String) }),
      expect.objectContaining({ type: "execute", action: { action: "observe" }, version: 1, id: expect.any(String) }),
    ]);
  });

  it("maps structured errors", async () => {
    const { client } = await fixture((request) => ({
      id: request.id,
      ok: false,
      error: { code: "stale_observation", message: "observe again", recovery: "Call observe." },
    }));
    await expect(client.execute({ action: "press", revision: "old", nodeId: "old:1" })).rejects.toMatchObject({
      code: "stale_observation",
      recovery: "Call observe.",
    });
  });

  it("reports offline, timeout, abort, and oversized responses", async () => {
    expect(await new ComputerRelayClient({ socketPath: "/tmp/missing-computer-relay.sock", exists: () => false }).status())
      .toEqual({ available: false });

    const timeoutFixture = await fixture(() => "");
    await expect(new ComputerRelayClient({ socketPath: timeoutFixture.path, timeoutMs: 30 }).execute({ action: "observe" }))
      .rejects.toMatchObject({ code: "action_timeout" });

    const abortFixture = await fixture(() => "");
    const controller = new AbortController();
    const pending = abortFixture.client.execute({ action: "observe" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });

    // CI can take longer than one second to drain a 6 MiB Unix-socket payload.
    // Use the production timeout so this assertion measures the size guard, not scheduler load.
    const oversized = await fixture(() => `${"x".repeat(6 * 1024 * 1024 + 1)}\n`, 8_000);
    await expect(oversized.client.execute({ action: "observe" })).rejects.toMatchObject({ code: "protocol_error" });
  });
});

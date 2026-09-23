import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  ComputerOperationError,
  ComputerRelayClient,
  type ComputerAction,
  type ComputerObservation,
  type ComputerRuntimePort,
} from "@agent/computer-use";
import { ComputerRelayServer } from "./computer-relay-server";

const directories: string[] = [];
const servers: ComputerRelayServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const axObservation = (revision = "ax_1"): ComputerObservation => ({
  source: "accessibility",
  revision,
  coverage: "complete",
  app: { name: "Fixture", bundleId: "dev.fixture", pid: 1 },
  nodes: [],
});

async function start(runtime?: ComputerRuntimePort) {
  // macOS limits Unix-domain socket paths to roughly 104 bytes. Keep the
  // fixture under the short /tmp alias rather than the long per-user TMPDIR.
  const directory = await mkdtemp("/tmp/agent-cu-");
  directories.push(directory);
  const socketPath = join(directory, "private", "computer-relay.sock");
  const server = new ComputerRelayServer({
    socketPath,
    runtime: runtime ?? {
      status: async () => ({ available: true, platform: "darwin", protocolVersion: 1 }),
      execute: async () => axObservation(),
    },
  });
  servers.push(server);
  await server.start();
  return { server, socketPath, client: new ComputerRelayClient({ socketPath }) };
}

function rawRequest(socketPath: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(line));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => {
      try { resolve(JSON.parse(response.trim()) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    socket.on("error", reject);
  });
}

describe("ComputerRelayServer", () => {
  it("creates a private socket and serves status and execute", async () => {
    const { socketPath, client } = await start();
    expect((await stat(join(socketPath, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await expect(client.status()).resolves.toMatchObject({ available: true, platform: "darwin", protocolVersion: 1 });
    await expect(client.execute({ action: "observe" })).resolves.toMatchObject({ revision: "ax_1" });
  });

  it("rejects malformed, incompatible, unsupported, and oversized requests", async () => {
    const { socketPath } = await start();
    await expect(rawRequest(socketPath, "not-json\n")).resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
    await expect(rawRequest(socketPath, '{"id":"bad-version","version":2,"type":"status"}\n'))
      .resolves.toMatchObject({ id: "bad-version", ok: false, error: { code: "protocol_error" } });
    await expect(rawRequest(socketPath, '{"id":"bad-type","version":1,"type":"shell"}\n'))
      .resolves.toMatchObject({ id: "bad-type", ok: false, error: { code: "invalid_request" } });
    await expect(rawRequest(socketPath, `${"x".repeat(128 * 1024 + 1)}\n`))
      .resolves.toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("returns structured runtime failures and handles concurrent clients", async () => {
    let sequence = 0;
    const runtime: ComputerRuntimePort = {
      status: async () => ({ available: true, platform: "darwin", protocolVersion: 1 }),
      execute: async (action: ComputerAction) => {
        if (action.action === "press") throw new ComputerOperationError("stale_observation", "observe again", "Call observe.");
        const current = ++sequence;
        await new Promise((resolve) => setTimeout(resolve, current === 1 ? 20 : 1));
        return axObservation(`ax_${current}`);
      },
    };
    const { client } = await start(runtime);
    await expect(client.execute({ action: "press", revision: "old", nodeId: "old:1" }))
      .rejects.toMatchObject({ code: "stale_observation", recovery: "Call observe." });
    const results = await Promise.all([client.execute({ action: "observe" }), client.execute({ action: "observe" })]);
    expect(results.map((result) => result.revision).sort()).toEqual(["ax_1", "ax_2"]);
  });

  it("removes the socket on close", async () => {
    const { server, socketPath } = await start();
    expect(existsSync(socketPath)).toBe(true);
    await server.close();
    expect(existsSync(socketPath)).toBe(false);
    servers.splice(servers.indexOf(server), 1);
  });
});

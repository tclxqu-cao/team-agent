import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { discoverVSCodeAgentEndpoints, type VSCodeAgentEndpoint } from "./copilot-vscode-discovery.js";
import { VSCodeSocketTransport } from "./copilot-ahp-transport.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "ar-vscode-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const entries = join(root, "agent-host/local-endpoint/entries");
  await mkdir(entries, { recursive: true, mode: 0o700 });
  return { root, entries };
}

describe.skipIf(process.platform === "win32")("VS Code local endpoint discovery", () => {
  it("accepts only owner-protected live editor endpoints and skips stale, old or symlinked entries", async () => {
    const { root, entries } = await directory(); const socket = join(root, "live.sock");
    const server = createServer(); await new Promise<void>(resolve => server.listen(socket, resolve));
    cleanups.push(() => new Promise(resolve => server.close(() => resolve())));
    const endpoint = { schemaVersion: 2, type: "editor", instanceId: "live", pid: process.pid, protocolVersion: "1.1.0", endpoint: { type: "socket", path: socket }, connectionToken: "fixture-secret" };
    const save = async (name: string, value: unknown, mode = 0o600) => writeFile(join(entries, name), JSON.stringify(value), { mode });
    await save("live.json", endpoint);
    await save("old.json", { ...endpoint, instanceId: "old", protocolVersion: "0.8.0" });
    await save("dead.json", { ...endpoint, instanceId: "dead", pid: 1234567 });
    await save("shared.json", { ...endpoint, instanceId: "shared" }, 0o644);
    await save("remote.json", { ...endpoint, instanceId: "remote", type: "remote" });
    await writeFile(join(entries, "invalid.json"), "{", { mode: 0o600 });
    await symlink(join(entries, "live.json"), join(entries, "link.json"));
    expect((await discoverVSCodeAgentEndpoints([root], pid => pid === process.pid)).map(endpoint => endpoint.instanceId)).toEqual(["live"]);
    await chmod(entries, 0o755);
    expect(await discoverVSCodeAgentEndpoints([root])).toEqual([]);
  });

  it("uses the existing socket and token without exposing the secret in errors", async () => {
    const { root } = await directory(); const socket = join(root, "host.sock");
    const http = createHttpServer(); const ws = new WebSocketServer({ noServer: true });
    const urls: string[] = [];
    http.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url!, "http://localhost");
      urls.push(url.searchParams.get("tkn") ?? "");
      ws.handleUpgrade(request, socket, head, connection => { connection.on("message", data => connection.send(data.toString())); });
    });
    await new Promise<void>(resolve => http.listen(socket, resolve));
    cleanups.push(() => new Promise(resolve => http.close(() => resolve())));
    cleanups.push(async () => { for (const client of ws.clients) client.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); });
    const endpoint: VSCodeAgentEndpoint = { instanceId: "test", pid: process.pid, protocolVersion: "1.1.0", endpoint: { type: "socket", path: socket }, connectionToken: "fixture token?&secret" };
    const transport = await VSCodeSocketTransport.open(endpoint);
    transport.send('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(await transport.recv()).toMatchObject({ kind: "text", text: expect.stringContaining('"ping"') });
    expect(urls).toEqual([endpoint.connectionToken]);
    transport.close();
    await expect(VSCodeSocketTransport.open({ ...endpoint, endpoint: { type: "socket", path: join(root, "missing.sock") } })).rejects.toThrow("无法连接 VS Code");
    await VSCodeSocketTransport.open({ ...endpoint, endpoint: { type: "socket", path: join(root, "missing.sock") } }).catch(error => {
      expect(error.message).not.toContain(endpoint.connectionToken); expect(error.message).not.toContain("tkn");
    });
  });
});

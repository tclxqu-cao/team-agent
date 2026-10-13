import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { DeepSeekHarnessClient } from "./deepseek-harness-client.js";

async function nativeHost() {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(303, { "set-cookie": "dsh=launch-cookie", location: "./" }); res.end(); return; }
    expect(req.headers.cookie).toMatch(/^dsh=(?:borrowed|launch-cookie)$/);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body.method);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, cookie: "dsh=borrowed", calls, close: () => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  }) };
}

describe("DeepSeek Harness transport", () => {
  it("uses launch-cookie authentication, exact native RPC envelopes and stream errors", async () => {
    const calls: unknown[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === "GET") { res.writeHead(302, { "set-cookie": "dsh=test-cookie; HttpOnly", location: "/" }); res.end(); return; }
      expect(req.headers.cookie).toBe("dsh=test-cookie");
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: body.method === "session/list" ? { ok: true, value: { items: [] } } : { ok: false, error: { code: "session/writer-held", message: "busy" } } }));
    });
    const sockets = new WebSocketServer({ server, path: "/api/remote.mux" });
    sockets.on("connection", (socket, req) => {
      expect(req.headers.cookie).toBe("dsh=test-cookie");
      socket.on("message", raw => {
        const opening = JSON.parse(raw.toString()); calls.push(opening);
        socket.send(JSON.stringify({ type: "item", streamId: opening.streamId, value: { type: "snapshot", cursor: 0, records: [] } }));
        socket.send(JSON.stringify({ type: "error", streamId: opening.streamId, error: { code: "session/writer-held", message: "writer unavailable" } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const client = new DeepSeekHarnessClient({ url: `http://127.0.0.1:${address.port}/?token=test` });
    try {
      expect(await client.request("session/list", { _request: {} })).toEqual({ items: [] });
      expect(calls[0]).toMatchObject({ type: "client-request", method: "session/list", payload: { args: { _request: {} } } });
      await expect(client.request("session/prompt", {})).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
      const stream = await client.follow({ address: { kind: "session", sessionId: "native" } });
      const iterator = stream.values[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: "snapshot" });
      await expect(iterator.next()).rejects.toMatchObject({ code: "SESSION_OCCUPIED", message: "writer unavailable" });
      expect(calls[2]).toMatchObject({ type: "open", endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId: "native" } } } } });
    } finally {
      await client.dispose();
      sockets.clients.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("rejects non-loopback runtime endpoints before contacting them", async () => {
    const client = new DeepSeekHarnessClient({ url: "https://external.example/?token=test" });
    await expect(client.request("session/list", {})).rejects.toThrow("本机 HTTP 地址");
    await client.dispose();
  });

  it("shares one discovered connection and leaves a borrowed Host alive after disposal", async () => {
    const host = await nativeHost();
    const discoverEndpoint = vi.fn(async () => host);
    const client = new DeepSeekHarnessClient({ discoverEndpoint, executable: "/missing/must-not-spawn" });
    try {
      expect(await Promise.all([client.request("session/list", {}), client.request("session/list", {})]))
        .toEqual([{ items: [] }, { items: [] }]);
      expect(discoverEndpoint).toHaveBeenCalledTimes(1);
      await client.dispose();
      const second = new DeepSeekHarnessClient({ url: `${host.origin}/?token=fixture` });
      try { expect(await second.request("session/list", {})).toEqual({ items: [] }); }
      finally { await second.dispose(); }
    } finally { await client.dispose(); await host.close(); }
  });

  it("honors explicit runtime addresses without discovery or silent fallback", async () => {
    const host = await nativeHost();
    const discoverEndpoint = vi.fn(async () => null);
    const client = new DeepSeekHarnessClient({ env: { AGENT_DSH_URL: `${host.origin}/?token=fixture` }, discoverEndpoint });
    try {
      expect(await client.request("session/list", {})).toEqual({ items: [] });
      expect(discoverEndpoint).not.toHaveBeenCalled();
    } finally { await client.dispose(); await host.close(); }
  });

  it("renews a borrowed native cookie before expiry", async () => {
    const host = await nativeHost();
    const discoverEndpoint = vi.fn().mockResolvedValueOnce({ ...host, refreshAt: Date.now() - 1 })
      .mockResolvedValue({ ...host, refreshAt: Date.now() + 60_000 });
    const client = new DeepSeekHarnessClient({ discoverEndpoint });
    try {
      await client.request("session/list", {});
      await client.request("session/list", {});
      expect(discoverEndpoint).toHaveBeenCalledTimes(2);
    } finally { await client.dispose(); await host.close(); }
  });

  it("rediscovers after a broken connection without replaying a write request", async () => {
    const first = await nativeHost();
    const second = await nativeHost();
    const discoverEndpoint = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
    const client = new DeepSeekHarnessClient({ discoverEndpoint });
    try {
      await client.request("session/list", {});
      await first.close();
      await expect(client.request("session/prompt", { content: "do not replay" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect(discoverEndpoint).toHaveBeenCalledTimes(1);
      expect(await client.request("session/list", {})).toEqual({ items: [] });
      expect(discoverEndpoint).toHaveBeenCalledTimes(2);
      expect(second.calls).toEqual(["session/list"]);
    } finally { await client.dispose(); await second.close(); }
  });

  it.skipIf(process.platform === "win32")("starts and owns a Web process only when discovery has no usable Host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-owned-host-"));
    const executable = join(directory, "dsh-fixture");
    const pidFile = join(directory, "pid");
    await writeFile(executable, `#!${process.execPath}\nconst http=require('node:http');const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const server=http.createServer(async(req,res)=>{if(req.method==='GET'){res.writeHead(303,{'set-cookie':'dsh=owned',location:'./'});res.end();return;}let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:true,value:{items:[]}}}));});
server.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?token=fixture'));\n`);
    await chmod(executable, 0o700);
    const discoverEndpoint = vi.fn(async () => null);
    const client = new DeepSeekHarnessClient({ discoverEndpoint, executable });
    try {
      expect(await client.request("session/list", {})).toEqual({ items: [] });
      expect(discoverEndpoint).toHaveBeenCalledTimes(1);
      const pid = Number(await readFile(pidFile, "utf8"));
      await client.dispose();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally { await client.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});

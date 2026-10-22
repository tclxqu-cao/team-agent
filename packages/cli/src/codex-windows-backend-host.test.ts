import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { startWindowsBackendHost } from "./codex-windows-backend-host.js";

it("bridges separate WebSocket clients through daemon proxies and rejects binary input", async () => {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const endpoint = `ws://127.0.0.1:${port}/${"a".repeat(48)}`;
  const startDaemon = vi.fn(async () => {});
  const spawnProxy = vi.fn((_executable, args) => {
    expect(args).toEqual(["app-server", "proxy"]);
    return spawn(process.execPath, ["-e", `const r=require('readline').createInterface({input:process.stdin});r.on('line',l=>process.stdout.write(l+'\\n'));`], { stdio: ["pipe", "pipe", "ignore"] });
  });
  const server = await startWindowsBackendHost({ version: 1, endpoint, executable: "C:\\codex.exe", codexHome: "C:\\Users\\test\\.codex" }, { startDaemon, spawnProxy: spawnProxy as typeof spawn });
  const clients: WebSocket[] = [];
  try {
    for (let id = 1; id <= 2; id++) {
      const socket = new WebSocket(endpoint); clients.push(socket); await once(socket, "open");
      const reply = once(socket, "message"); socket.send(JSON.stringify({ id, method: "config/read" }));
      expect(JSON.parse(String((await reply)[0]))).toEqual({ id, method: "config/read" });
    }
    expect(startDaemon).toHaveBeenCalledOnce(); expect(spawnProxy).toHaveBeenCalledTimes(2);
    const closed = once(clients[0]!, "close"); clients[0]!.send(Buffer.from("bad"));
    expect((await closed)[0]).toBe(1003);
    const reply = once(clients[1]!, "message"); clients[1]!.send('{"id":3}');
    expect(String((await reply)[0])).toBe('{"id":3}');
  } finally {
    for (const socket of clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { WebSocketServer, WebSocket } from "ws";
import { validateWindowsBackend, type WindowsBackendConfig } from "./codex-windows-backend.js";

export async function startWindowsBackendHost(config: WindowsBackendConfig, dependencies: {
  startDaemon?: (executable: string, environment: NodeJS.ProcessEnv) => Promise<void>;
  spawnProxy?: typeof spawn;
} = {}): Promise<WebSocketServer> {
  validateWindowsBackend(config);
  const environment = { ...process.env, CODEX_HOME: config.codexHome };
  await (dependencies.startDaemon ?? (async (executable, env) => {
    await promisify(execFile)(executable, ["app-server", "daemon", "start"], { env, cwd: homedir(), windowsHide: true, timeout: 30_000 });
  }))(config.executable, environment);
  const endpoint = new URL(config.endpoint);
  const server = new WebSocketServer({ host: "127.0.0.1", port: Number(endpoint.port), path: endpoint.pathname, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
  server.on("connection", socket => {
    const child = (dependencies.spawnProxy ?? spawn)(config.executable, ["app-server", "proxy"], { env: environment, cwd: homedir(), windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", line => { if (socket.readyState === WebSocket.OPEN) { if (socket.bufferedAmount > 32 * 1024 * 1024) socket.close(1013); else socket.send(line); } });
    socket.on("message", (data, binary) => {
      if (binary || (Array.isArray(data) ? data.reduce((size, chunk) => size + chunk.length, 0) : data.byteLength) > 32 * 1024 * 1024) { socket.close(1003); return; }
      try {
        const message = JSON.parse(String(data));
        if (!message || typeof message !== "object" || Array.isArray(message) || child.stdin!.writableLength > 32 * 1024 * 1024) { socket.close(1008); return; }
        child.stdin!.write(`${JSON.stringify(message)}\n`);
      } catch { socket.close(1007); }
    });
    socket.on("error", () => {});
    const close = () => { lines.close(); child.stdin!.end(); if (child.exitCode === null) child.kill(); };
    socket.once("close", close);
    child.once("error", () => socket.close(1011)); child.once("exit", () => socket.close(1011));
  });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) process.exitCode = 1;
  else readFile(path, "utf8").then(text => startWindowsBackendHost(validateWindowsBackend(JSON.parse(text)))).catch(() => { console.error("Windows shared backend failed to start"); process.exitCode = 1; });
}

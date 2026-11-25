import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, readFile, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { WebSocket, createWebSocketStream } from "ws";
import { writePrivateText } from "../service/service-files.js";
import type { TunnelHandle, TunnelProvider } from "./tunnel-provider.js";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function relayOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/.test(url.hostname)) {
    throw new Error("自建 HTTPS 入口需要一个 HTTPS 域名");
  }
  return url;
}

export function readDefaultRelayUrl(): string | null {
  const configured = process.env.AGENTROAM_HTTPS_RELAY_URL?.trim();
  if (configured) return configured;
  const path = new URL("../self-hosted-relay.json", import.meta.url);
  try {
    const url: unknown = JSON.parse(readFileSync(path, "utf8")).url;
    return typeof url === "string" ? url : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

async function installationToken(dataDir: string): Promise<string> {
  const path = join(dataDir, "relay", "identity");
  const existing = await readToken(path);
  if (existing) return existing;
  const temporary = `${path}.${randomBytes(8).toString("hex")}.pending`;
  await writePrivateText(temporary, randomBytes(32).toString("base64url"));
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary);
  }
  const token = await readToken(path);
  if (!token) throw new Error("自建 HTTPS 入口的本机身份未能保存");
  return token;
}

async function readToken(path: string): Promise<string | null> {
  const token = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (token !== null && !tokenPattern.test(token)) throw new Error("自建 HTTPS 入口的本机身份文件无效");
  return token;
}

export class SelfHostedTunnelProvider implements TunnelProvider {
  constructor(
    private readonly url: string,
    private readonly dataDir: string,
    private readonly dial: (url: URL, options: WebSocket.ClientOptions) => WebSocket = (url, options) => new WebSocket(url, options),
  ) {}

  async start({ localUrl, signal }: { localUrl: string; signal: AbortSignal }): Promise<TunnelHandle> {
    const root = relayOrigin(this.url);
    const token = await installationToken(this.dataDir);
    const local = new URL(localUrl);
    if (local.protocol !== "http:" || local.hostname !== "127.0.0.1" || !local.port) {
      throw new Error("自建 HTTPS 入口只能转发本机 AgentRoam 服务");
    }
    const name = createHash("sha256").update(token).digest("hex").slice(0, 32);
    const publicUrl = `https://d-${name}.${root.host}`;
    const options = { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 8_000, maxPayload: 1024 * 1024, perMessageDeflate: false };
    const websocket = (path: string) => this.dial(new URL(`wss://${root.host}${path}`), options);
    signal.throwIfAborted();
    const control = websocket("/v1/connect");
    const streams = new Set<WebSocket>();
    const close = () => {
      control.terminate();
      for (const socket of streams) socket.terminate();
    };
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      control.once("close", code => {
        signal.removeEventListener("abort", close);
        for (const socket of streams) socket.terminate();
        resolve({ code, signal: null });
      });
    });
    signal.addEventListener("abort", close, { once: true });

    try {
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        control.on("error", reject);
        void exited.then(() => reject(new Error("自建 HTTPS 入口连接已断开")));
        control.on("message", chunk => {
          try {
            const message = JSON.parse(String(chunk));
            if (!ready && message?.type === "ready" && message.publicUrl === publicUrl) {
              ready = true;
              resolve();
            } else if (ready && message?.type === "stream" && /^[a-f0-9]{32}$/.test(message.id) && streams.size < 64) {
              const socket = websocket(`/v1/streams/${message.id}`);
              streams.add(socket);
              socket.once("close", () => streams.delete(socket));
              connectToLoopback(socket, Number(local.port));
            } else {
              close();
            }
          } catch (error) {
            reject(error);
            close();
          }
        });
      });
      signal.throwIfAborted();
      return { publicUrl, exited, close: async () => { close(); await exited; } };
    } catch (error) {
      close();
      throw error;
    }
  }
}

function connectToLoopback(socket: WebSocket, port: number): void {
  const stream = createWebSocketStream(socket);
  // The remote can send immediately after the WebSocket handshake. Buffer on
  // the stream until the local service accepts the socket.
  const local = connect({ host: "127.0.0.1", port });
  stream.on("error", () => local.destroy());
  local.on("error", () => stream.destroy());
  stream.once("close", () => local.destroy());
  local.once("connect", () => stream.pipe(local).pipe(stream));
}

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveNativeRuntimeDirectory } from "../agent-runtime/native-runtime-broker.js";
import {
  AI_HUB_RELAY_SOCKET_NAME,
  MAX_RELAY_IMAGES,
  MAX_RELAY_IMAGE_LENGTH,
  MAX_RELAY_SITES,
  MAX_RELAY_TEXT_LENGTH,
} from "@agent/core";
import type { AIHubManager, HubBroadcastResult } from "./manager.js";

// AI Hub 桌面端中继：桌面 App 持有一个 Unix 域 socket（行式 JSON 请求/响应），
// :3000 server 收到 web 控制台的 aihub:send 后连过来，由桌面端的
// WebContentsView（已登录会话）执行真实注入。桌面没运行 = socket 不存在 = 离线。
// socket 目录沿用 native-runtime broker 的解析约定，两端无需额外配置即可对齐。
// 协议常量（上限、socket 名）定义在 core 的 domain/ai-hub/relay-protocol，server
// 侧预校验与客户端共用同一份，避免三处漂移。

export { AI_HUB_RELAY_SOCKET_NAME, MAX_RELAY_IMAGES, MAX_RELAY_IMAGE_LENGTH, MAX_RELAY_SITES, MAX_RELAY_TEXT_LENGTH };
const RELAY_IMAGE_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export type AiHubRelayRequest =
  | { kind: "status" }
  | { kind: "broadcast"; text: string; siteIds: string[]; images: string[] }
  | { kind: "capture"; siteIds: string[] };

// 图片校验（纯函数，便于单测）：非字符串/格式不符/超长的条目直接丢弃，最多保留 MAX_RELAY_IMAGES 张
export function normalizeRelayImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string"
      && item.length <= MAX_RELAY_IMAGE_LENGTH
      && RELAY_IMAGE_PATTERN.test(item))
    .slice(0, MAX_RELAY_IMAGES);
}

// 行式 JSON 入站消息校验（纯函数，便于单测）
export function parseRelayMessage(line: string): AiHubRelayRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;
  if (message.type === "status") return { kind: "status" };
  if (message.type === "capture") {
    if (!Array.isArray(message.siteIds)) return null;
    const siteIds = message.siteIds
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, MAX_RELAY_SITES);
    if (siteIds.length === 0) return null;
    return { kind: "capture", siteIds };
  }
  if (message.type === "broadcast") {
    const text = typeof message.text === "string" ? message.text : "";
    const images = normalizeRelayImages(message.images);
    // 纯图片发送允许空文本；超长文本、或文本图片全空才拒绝
    if (text.length > MAX_RELAY_TEXT_LENGTH) return null;
    if (images.length === 0 && !text.trim()) return null;
    if (!Array.isArray(message.siteIds)) return null;
    const siteIds = message.siteIds
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, MAX_RELAY_SITES);
    if (siteIds.length === 0) return null;
    return { kind: "broadcast", text, siteIds, images };
  }
  return null;
}

export function relaySocketPath(directory?: string): string {
  return join(resolveNativeRuntimeDirectory(directory), AI_HUB_RELAY_SOCKET_NAME);
}

export interface AiHubRelay {
  readonly socketPath: string;
  close(): void;
}

// 桌面单实例锁保证只有一个 App；崩溃残留的 socket 文件直接清理重建。
export async function startAiHubRelay(manager: AIHubManager, directory?: string): Promise<AiHubRelay> {
  const socketPath = relaySocketPath(directory);
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });
  const server: Server = createServer((socket) => handleConnection(socket, manager));
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(socketPath, () => resolvePromise());
  });
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    // best effort：同用户目录下权限已足够
  }
  return {
    socketPath,
    close() {
      server.close();
      if (existsSync(socketPath)) rmSync(socketPath, { force: true });
    },
  };
}

function handleConnection(socket: Socket, manager: AIHubManager): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) void handleLine(socket, manager, line);
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("error", () => socket.destroy());
}

async function handleLine(socket: Socket, manager: AIHubManager, line: string): Promise<void> {
  let id = "";
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      raw = null;
    }
    if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).id === "string") {
      id = (raw as Record<string, unknown>).id as string;
    }
    const request = parseRelayMessage(line);
    if (!request) throw new Error("invalid aihub relay request");
    if (request.kind === "status") {
      const sites = manager.getConfig().sites.map((site) => ({ id: site.id, name: site.name, url: site.url }));
      writeLine(socket, { id, ok: true, result: { sites } });
      return;
    }
    if (request.kind === "capture") {
      const results = await manager.captureConversations(request.siteIds);
      writeLine(socket, { id, ok: true, result: { results } });
      return;
    }
    const results: HubBroadcastResult[] = await manager.relayBroadcast(request.text, request.siteIds, request.images);
    writeLine(socket, { id, ok: true, result: { results } });
  } catch (error) {
    writeLine(socket, {
      id,
      ok: false,
      error: { message: error instanceof Error ? error.message.slice(0, 200) : "relay error" },
    });
  }
}

function writeLine(socket: Socket, payload: unknown): void {
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // socket 已断开
  }
}

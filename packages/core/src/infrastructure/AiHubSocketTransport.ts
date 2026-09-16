// AI Hub 桌面端中继客户端（AiHubTransport 默认实现）：连接桌面 App 持有的
// ai-hub-relay.sock（Unix 域，行式 JSON 请求/响应）。桌面 App 没运行 =
// socket 不存在 = 离线。协议常量与 socket 路径解析统一定义在
// domain/ai-hub/relay-protocol，与桌面端、ws-server 共用同一份。
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { resolveAiHubRelaySocketPath } from "../domain/ai-hub/relay-protocol.js";
import type {
  AiHubCaptureResult,
  AiHubRelayResult,
  AiHubSiteInfo,
  AiHubTransport,
} from "../domain/ai-hub/transport.js";

interface RelayResponse {
  id?: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

export function desktopOfflineError(): Error {
  return Object.assign(new Error("AI Hub 桌面端离线：请启动 AgentRoam 桌面 App（AI Hub 站点登录态保存在桌面端）"), { code: "EDESKTOPOFFLINE" });
}

function relayRequest(socketPath: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!existsSync(socketPath)) {
      rejectPromise(desktopOfflineError());
      return;
    }
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(result ?? {});
    };
    const timer = setTimeout(() => finish(new Error("aihub relay timeout")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let message: RelayResponse;
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(new Error("invalid aihub relay response"));
        return;
      }
      if (message.id !== id) return;
      if (message.ok) finish(null, message.result);
      else finish(new Error(message.error?.message || "aihub relay error"));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish(error?.code === "ENOENT" ? desktopOfflineError() : error);
    });
  });
}

interface BroadcastPayload {
  available: boolean;
  reason?: string;
  results: AiHubRelayResult[];
}

interface CapturePayload {
  available: boolean;
  reason?: string;
  results: AiHubCaptureResult[];
}

export class AiHubSocketTransport implements AiHubTransport {
  async status(): Promise<{ available: boolean; sites?: AiHubSiteInfo[] }> {
    try {
      const result = await relayRequest(resolveAiHubRelaySocketPath(), { type: "status" }, 4000);
      return { available: true, sites: (result.sites as AiHubSiteInfo[] | undefined) ?? [] };
    } catch {
      return { available: false };
    }
  }

  async broadcast(text: string, siteIds: string[], images: string[] = [], conversationId?: string): Promise<BroadcastPayload> {
    const payload: Record<string, unknown> = { type: "broadcast", text, siteIds, background: true, ...(conversationId ? { conversationId } : {}) };
    if (images.length > 0) payload.images = images;
    try {
      const result = await relayRequest(resolveAiHubRelaySocketPath(), payload, 45000);
      return { available: true, results: (result.results as AiHubRelayResult[] | undefined) ?? [] };
    } catch (error) {
      return offlinePayload<AiHubRelayResult>(error, siteIds);
    }
  }

  async capture(siteIds: string[], conversationId?: string): Promise<CapturePayload> {
    try {
      const result = await relayRequest(resolveAiHubRelaySocketPath(), { type: "capture", siteIds, ...(conversationId ? { conversationId } : {}) }, 15000);
      return { available: true, results: (result.results as AiHubCaptureResult[] | undefined) ?? [] };
    } catch (error) {
      return offlinePayload<AiHubCaptureResult>(error, siteIds);
    }
  }

  async continueGeneration(siteIds: string[], conversationId?: string): Promise<BroadcastPayload> {
    try {
      const result = await relayRequest(resolveAiHubRelaySocketPath(), { type: "continue", siteIds, ...(conversationId ? { conversationId } : {}) }, 15000);
      return { available: true, results: (result.results as AiHubRelayResult[] | undefined) ?? [] };
    } catch (error) {
      return offlinePayload<AiHubRelayResult>(error, siteIds);
    }
  }
}

function offlinePayload<T>(error: unknown, siteIds: string[]): { available: boolean; reason: string; results: T[] } {
  const reason = error instanceof Error
    ? (error.message === "aihub relay timeout" ? "timeout" : error.message.slice(0, 120))
    : "relay-error";
  return { available: false, reason, results: siteIds.map(() => ({ ok: false, reason }) as T) };
}

// AI Hub 桌面端中继客户端：连接桌面 App 持有的 ai-hub-relay.sock（Unix 域，
// 行式 JSON 请求/响应）。socket 目录解析与协议常量统一定义在 core 的
// domain/ai-hub/relay-protocol，与桌面端、ws-server 共用同一份。
// 桌面 App 没运行 = socket 不存在 = 离线。
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { resolveAiHubRelaySocketPath } from "@agent/core";

export { resolveAiHubRelaySocketPath };

function offlineError() {
  return Object.assign(new Error("desktop offline"), { code: "EDESKTOPOFFLINE" });
}

export function relayRequest(socketPath, payload, timeoutMs = 45000) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!existsSync(socketPath)) {
      rejectPromise(offlineError());
      return;
    }
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    const timer = setTimeout(() => finish(new Error("aihub relay timeout")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let message;
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
    socket.on("error", (error) => {
      finish(error?.code === "ENOENT" ? offlineError() : error);
    });
  });
}

export async function aiHubRelayStatus(env = process.env) {
  try {
    const result = await relayRequest(resolveAiHubRelaySocketPath(env), { type: "status" }, 4000);
    return { available: true, ...result };
  } catch {
    return { available: false };
  }
}

// 永远 resolve（不 reject）：逐站结果里带 ok/reason，离线时 available=false
// images：data:image/*;base64 数据 URL 数组（ws-server 已做过类型/数量过滤）
export async function aiHubRelayBroadcast(text, siteIds, images = [], env = process.env) {
  const payload = { type: "broadcast", text, siteIds };
  if (Array.isArray(images) && images.length > 0) payload.images = images;
  try {
    const result = await relayRequest(
      resolveAiHubRelaySocketPath(env),
      payload,
      45000,
    );
    return { available: true, ...result };
  } catch (error) {
    const reason = error?.code === "EDESKTOPOFFLINE"
      ? "desktop-offline"
      : error?.message === "aihub relay timeout"
        ? "timeout"
        : "relay-error";
    return {
      available: false,
      reason,
      results: siteIds.map((siteId) => ({ siteId, ok: false, reason })),
    };
  }
}

// 会话抓取：向桌面端请求已打开站点的对话内容（只读）。永远 resolve。
export async function aiHubRelayCapture(siteIds, env = process.env) {
  try {
    const result = await relayRequest(
      resolveAiHubRelaySocketPath(env),
      { type: "capture", siteIds },
      15000,
    );
    return { available: true, ...result };
  } catch (error) {
    const reason = error?.code === "EDESKTOPOFFLINE"
      ? "desktop-offline"
      : error?.message === "aihub relay timeout"
        ? "timeout"
        : "relay-error";
    return {
      available: false,
      reason,
      results: siteIds.map((siteId) => ({ siteId, ok: false, reason })),
    };
  }
}

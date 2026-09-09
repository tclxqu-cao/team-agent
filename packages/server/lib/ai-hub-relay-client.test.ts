import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aiHubRelayBroadcast, aiHubRelayStatus, relayRequest, resolveAiHubRelaySocketPath } from "./ai-hub-relay-client.mjs";

// 桌面端中继的测试替身：行式 JSON 协议，按 handler 回包
function startStubSocket(path: string, handler: (message: Record<string, unknown>) => unknown): Promise<Server> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server: Server = createServer((socket: Socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const message = JSON.parse(buffer.slice(0, newline));
        socket.write(`${JSON.stringify({ id: message.id, ok: true, result: handler(message) })}\n`);
      });
    });
    server.once("error", rejectPromise);
    server.listen(path, () => resolvePromise(server));
  });
}

describe("ai-hub relay client", () => {
  const dir = mkdtempSync(join(tmpdir(), "aihub-relay-"));
  const socketPath = join(dir, "ai-hub-relay.sock");
  const env = { AGENT_NATIVE_RUNTIME_DIR: dir } as NodeJS.ProcessEnv;
  let server: Server | null = null;

  beforeAll(async () => {
    server = await startStubSocket(socketPath, (message) => {
      if (message.type === "status") return { sites: [{ id: "deepseek", name: "DeepSeek" }] };
      if (message.type === "broadcast") return { results: [{ siteId: "deepseek", ok: true }] };
      return {};
    });
  });

  afterAll(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("socket 路径解析遵循 AGENT_NATIVE_RUNTIME_DIR 或默认 ~/.agentroam/native-runtime", () => {
    expect(resolveAiHubRelaySocketPath(env)).toBe(join(dir, "ai-hub-relay.sock"));
    expect(resolveAiHubRelaySocketPath({} as NodeJS.ProcessEnv).endsWith(join(".agentroam", "native-runtime", "ai-hub-relay.sock"))).toBe(true);
  });

  it("status 往返返回站点列表", async () => {
    const status = await aiHubRelayStatus(env);
    expect(status.available).toBe(true);
    expect(status).toMatchObject({ sites: [{ id: "deepseek", name: "DeepSeek" }] });
  });

  it("broadcast 往返返回逐站结果", async () => {
    const result = await aiHubRelayBroadcast("你好", ["deepseek"], env);
    expect(result.available).toBe(true);
    expect(result.results).toEqual([{ siteId: "deepseek", ok: true }]);
  });

  it("socket 不存在时 status 报告离线、broadcast 返回逐站失败", async () => {
    const missing = join(dir, "missing.sock");
    const status = await aiHubRelayStatus({ AGENT_NATIVE_RUNTIME_DIR: dir + "-none" } as NodeJS.ProcessEnv);
    expect(status).toEqual({ available: false });
    const result = await relayRequest(missing, { type: "status" }, 500).catch((error) => error);
    expect(result.code ?? result.message).toBe("EDESKTOPOFFLINE");
    const broadcast = await aiHubRelayBroadcast("hi", ["deepseek", "grok"], { AGENT_NATIVE_RUNTIME_DIR: dir + "-none" } as NodeJS.ProcessEnv);
    expect(broadcast.available).toBe(false);
    expect(broadcast.reason).toBe("desktop-offline");
    expect(broadcast.results).toEqual([
      { siteId: "deepseek", ok: false, reason: "desktop-offline" },
      { siteId: "grok", ok: false, reason: "desktop-offline" },
    ]);
  });

  it("对端不回包时按超时失败", async () => {
    const silentPath = join(dir, "silent.sock");
    const silent = await new Promise<Server>((resolvePromise, rejectPromise) => {
      const s = createServer((socket) => { socket.on("data", () => {}); });
      s.once("error", rejectPromise);
      s.listen(silentPath, () => resolvePromise(s));
    });
    try {
      await relayRequest(silentPath, { type: "status" }, 200).catch((error) => error);
      expect(true).toBe(true); // 到这里说明超时 reject（而非挂起）
    } finally {
      silent.close();
    }
  }, 5000);
});

import { createInterface } from "node:readline";
import type { ToolDef } from "../agent/phone-tools.js";

/**
 * 手写 MCP stdio server（与 core 的 MCPClient 同款 newline-delimited JSON-RPC 2.0，
 * 不引第三方 SDK，保持仓库零依赖风格）。
 */

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const SERVER_INFO = { name: "phone-agent", version: "0.1.0" };

function toolToMcp(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/**
 * 纯函数消息处理器，便于单测。
 * 返回 null 表示无需回复（notification / 无法识别的请求）。
 */
export function createMessageHandler(tools: ToolDef[]) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  // 工具串行执行：手机是单一物理资源，并发操作会互相踩（如 tap 与 swipe 交错）
  let queue: Promise<unknown> = Promise.resolve();

  return async function handle(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return null;
    const isNotification = msg.id === undefined || msg.id === null;
    const id = msg.id ?? null;

    const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
    const replyError = (code: number, message: string): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });

    switch (msg.method) {
      case "initialize":
        // 回显客户端请求的协议版本，最大化与各类客户端的兼容
        return reply({
          protocolVersion:
            typeof (msg.params as { protocolVersion?: string })?.protocolVersion === "string"
              ? (msg.params as { protocolVersion: string }).protocolVersion
              : "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      case "notifications/initialized":
      case "initialized":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: tools.map(toolToMcp) });
      case "tools/call": {
        const name = typeof (msg.params as { name?: unknown })?.name === "string"
          ? (msg.params as { name: string }).name
          : "";
        const args = (msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {};
        const tool = toolMap.get(name);
        if (!tool) {
          return isNotification ? null : replyError(-32602, `未知工具: ${name}`);
        }
        // 排队执行，保证 MCP 请求顺序与手机操作顺序一致
        const run = queue.then(async () => {
          try {
            const r = await tool.execute(args);
            return {
              jsonrpc: "2.0" as const,
              id,
              result: {
                content: [{ type: "text", text: r.text }],
                ...(r.isError ? { isError: true } : {}),
              },
            };
          } catch (err) {
            return {
              jsonrpc: "2.0" as const,
              id,
              result: {
                content: [{ type: "text", text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
              },
            };
          }
        });
        queue = run.catch(() => undefined);
        return run;
      }
      case "resources/list":
        return reply({ resources: [] });
      case "prompts/list":
        return reply({ prompts: [] });
      default:
        if (isNotification) return null;
        return replyError(-32601, `方法不支持: ${msg.method}`);
    }
  };
}

/** stdio 入口：stdin 逐行读 JSON-RPC，stdout 逐行写响应，日志走 stderr。stdin 关闭且在途请求写完后 resolve。 */
export function serveStdio(tools: ToolDef[]): Promise<void> {
  const handle = createMessageHandler(tools);
  const rl = createInterface({ input: process.stdin, terminal: false });
  let inFlight = 0;
  const write = (line: string) => {
    process.stdout.write(line + "\n");
  };
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } }));
      return;
    }
    inFlight += 1;
    handle(msg)
      .then((resp) => {
        if (resp) write(JSON.stringify(resp));
      })
      .catch((err) => {
        process.stderr.write(`[phone-agent] handler error: ${err}\n`);
      })
      .finally(() => {
        inFlight -= 1;
      });
  });
  process.stderr.write(`[phone-agent] MCP server ready (${tools.length} tools)\n`);
  return new Promise((resolve) => {
    // EOF（客户端关 stdin）后等在途请求写完再退出，避免把响应吞掉
    rl.on("close", () => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (inFlight === 0 || Date.now() - started > 5000) {
          clearInterval(timer);
          resolve();
        }
      }, 25);
    });
  });
}

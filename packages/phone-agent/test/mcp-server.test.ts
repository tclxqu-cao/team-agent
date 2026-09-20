import { describe, expect, it } from "vitest";
import { createMessageHandler, type JsonRpcMessage } from "../src/mcp/server.js";
import type { ToolDef } from "../src/agent/phone-tools.js";

function fakeTools(): ToolDef[] {
  return [
    {
      name: "echo",
      description: "原样返回输入",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      execute: async (args) => ({ text: String(args.text ?? "") }),
    },
    {
      name: "boom",
      description: "总是抛错",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("模拟故障");
      },
    },
  ];
}

async function rpc(
  handler: ReturnType<typeof createMessageHandler>,
  msg: JsonRpcMessage,
): Promise<unknown> {
  return handler(msg);
}

describe("MCP message handler", () => {
  it("initialize 回显协议版本并声明 tools 能力", async () => {
    const handler = createMessageHandler(fakeTools());
    const resp = (await rpc(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })) as { result: Record<string, unknown> };
    expect(resp.result.protocolVersion).toBe("2025-06-18");
    expect((resp.result.capabilities as Record<string, unknown>).tools).toBeTruthy();
    expect((resp.result.serverInfo as Record<string, unknown>).name).toBe("phone-agent");
  });

  it("tools/list 返回工具定义", async () => {
    const handler = createMessageHandler(fakeTools());
    const resp = (await rpc(handler, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(resp.result.tools.map((t) => t.name)).toEqual(["echo", "boom"]);
    expect(resp.result.tools[0].inputSchema).toBeTruthy();
  });

  it("tools/call 成功返回 text content", async () => {
    const handler = createMessageHandler(fakeTools());
    const resp = (await rpc(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hello 手机" } },
    })) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    expect(resp.result.content[0].text).toBe("hello 手机");
    expect(resp.result.isError).toBeFalsy();
  });

  it("tools/call 工具抛错转为 isError 结果而非协议错误", async () => {
    const handler = createMessageHandler(fakeTools());
    const resp = (await rpc(handler, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "boom" },
    })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toContain("模拟故障");
  });

  it("未知工具返回 -32602", async () => {
    const handler = createMessageHandler(fakeTools());
    const resp = (await rpc(handler, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "nope" },
    })) as { error?: { code: number } };
    expect(resp.error?.code).toBe(-32602);
  });

  it("notification 不回包，未知方法回 -32601", async () => {
    const handler = createMessageHandler(fakeTools());
    expect(
      await rpc(handler, { jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
    const resp = (await rpc(handler, { jsonrpc: "2.0", id: 6, method: "no/such" })) as {
      error?: { code: number };
    };
    expect(resp.error?.code).toBe(-32601);
  });

  it("ping 返回空结果", async () => {
    const handler = createMessageHandler(fakeTools());
    const resp = (await rpc(handler, { jsonrpc: "2.0", id: 7, method: "ping" })) as {
      result: Record<string, never>;
    };
    expect(resp.result).toEqual({});
  });
});

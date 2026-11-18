import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createTodoMcpServer, runTodoMcpStdio } from "./stdio";

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: vi.fn() }));

async function localTodoServiceFixture(work: (fixture: {
  serviceId: string;
  descriptorPath: string;
  token: string;
}) => Promise<void>, scope = "manage") {
  const root = await mkdtemp(join(tmpdir(), "todo-mcp-stdio-test-"));
  const serviceId = "service-fixture";
  const token = "a".repeat(64);
  const descriptorPath = join(root, "credential");
  try {
    await writeFile(descriptorPath, JSON.stringify({ serviceId, token, scope, discoveryDirectory: root }), { mode: 0o600 });
    await writeFile(join(root, "service.json"), JSON.stringify({ serviceId, url: "http://127.0.0.1:9999/" }));
    await work({ serviceId, descriptorPath, token });
  } finally {
    vi.unstubAllGlobals();
    vi.mocked(StdioServerTransport).mockReset();
    await rm(root, { recursive: true, force: true });
  }
}

describe("Todo MCP protocol", () => {
  it("lists deferred tools while the service is offline and verifies identity on use after recovery", async () => {
    await localTodoServiceFixture(async ({ serviceId, descriptorPath, token }) => {
      let serviceAvailable = false;
      const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get("x-agentroam-todo-credential")).toBe(token);
        expect(new Headers(init.headers).get("x-agentroam-service-id")).toBe(serviceId);
        if (!serviceAvailable) throw new Error("Service offline");
        const { operation } = JSON.parse(init.body as string);
        return operation === "identity"
          ? Response.json({ serviceId, scope: "manage" })
          : Response.json({ task: { id: "todo-1" } });
      });
      vi.stubGlobal("fetch", fetch);
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      vi.mocked(StdioServerTransport).mockImplementationOnce(function () {
        return serverTransport as unknown as StdioServerTransport;
      });
      const client = new Client({ name: "test", version: "1" });
      try {
        await runTodoMcpStdio({ serviceId, descriptorPath, deferServiceCheck: true });
        await client.connect(clientTransport);
        expect((await client.listTools()).tools.some(tool => tool.name === "todo_get")).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
        const request = { name: "todo_get", arguments: { taskId: "todo-1" } };
        expect((await client.callTool(request)).isError).toBe(true);
        serviceAvailable = true;
        expect((await client.callTool(request)).isError).not.toBe(true);
        expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string).operation))
          .toEqual(["identity", "identity", "get"]);
      } finally {
        await client.close();
        await serverTransport.close();
      }
    });
  });

  it("waits for authenticated service identity before connecting scheduled tools", async () => {
    await localTodoServiceFixture(async ({ serviceId, descriptorPath }) => {
      const fetch = vi.fn(async () => { throw new Error("Service offline"); });
      vi.stubGlobal("fetch", fetch);
      await expect(runTodoMcpStdio({ serviceId, descriptorPath })).rejects.toThrow("Selected Todo service is unavailable");
      expect(fetch).toHaveBeenCalledOnce();
      expect(StdioServerTransport).not.toHaveBeenCalled();
    }, "execution");
  });

  it("initializes, lists management tools and forwards explicit requestId", async () => {
    const calls: unknown[] = [];
    const server = createTodoMcpServer({ call: async (op, args) => { calls.push([op, args]); return { id: "todo" }; } }, "manage");
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    try { const list = await client.listTools(); expect(list.tools).toHaveLength(11); expect(list.tools.some(t => t.name === "todo_schedule")).toBe(true);
      const result = await client.callTool({ name: "todo_create", arguments: { title: "验证", requestId: "stable-request" } }); expect(result.isError).not.toBe(true); expect(calls).toEqual([["execute", { command: { type: "create", title: "验证" }, requestId: "stable-request" }]]);
    } finally { await client.close(); await server.close(); }
  });
  it("execution credentials cannot mutate other Todos or complete a recurring task", async () => {
    const server = createTodoMcpServer({ call: async () => ({ ok: true }) }, "execution"), client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
    try { expect((await client.listTools()).tools.map(t => t.name)).toEqual(["todo_get", "todo_report_execution"]); expect((await client.callTool({ name: "todo_complete", arguments: {} })).isError).toBe(true); }
    finally { await client.close(); await server.close(); }
  });
});

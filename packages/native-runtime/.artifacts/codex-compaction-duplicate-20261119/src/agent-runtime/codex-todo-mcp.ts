import { createHash } from "node:crypto";
import type { NativeTodoMcpConfiguration } from "./runtime-tool-injection.js";
import { RuntimeSessionError } from "./types.js";

interface CodexTodoRpc {
  request<T>(method: string, params: unknown): Promise<T>;
}

/** A distinct name makes an ignored loaded-thread override detectable before sending. */
export function codexTodoMcpConfiguration(configuration: NativeTodoMcpConfiguration) {
  const server = { command: configuration.command, args: [...configuration.args],
    env: Object.fromEntries(Object.entries(configuration.env).sort(([left], [right]) => left.localeCompare(right))) };
  const fingerprint = createHash("sha256").update(JSON.stringify(server)).digest("hex").slice(0, 16);
  const serverName = `agentroam_todo_${fingerprint}`;
  return { serverName, config: { [`mcp_servers.${serverName}`]: { ...server, enabled: true, required: configuration.readiness !== "background" } } };
}

export async function assertCodexTodoMcpReady(client: CodexTodoRpc, threadId: string, serverName: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const result = await client.request<{ data?: Array<{ name?: string; runtimeStatus?: string; tools?: Record<string, { name?: string }> }> }>(
    "mcpServerStatus/list", { threadId, serverName, detail: "toolsAndAuthOnly" },
  );
  signal?.throwIfAborted();
  const server = result.data?.find(candidate => candidate.name === serverName);
  if (server?.runtimeStatus !== "connected" || !Object.values(server.tools ?? {}).some(tool => tool.name === "todo_get")) {
    throw new RuntimeSessionError(
      "无法确认该 Codex 会话的待办 MCP 已连接。若原客户端仍打开此会话，请等待它释放后重试。",
      "OPERATION_NOT_SUPPORTED",
    );
  }
}

export async function resumeCodexThreadWithTodo(
  client: CodexTodoRpc,
  threadId: string,
  configuration: NativeTodoMcpConfiguration,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const injection = codexTodoMcpConfiguration(configuration);
  // Drop only this connection's subscription. Native Codex rebuilds an idle
  // resident only when no other client is subscribed; it preserves active ones.
  await client.request("thread/unsubscribe", { threadId });
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      await client.request("thread/resume", { threadId, excludeTurns: true, config: injection.config });
      break;
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt >= 10 || !(error instanceof Error) || !/is closing; retry thread\/resume/.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  await assertCodexTodoMcpReady(client, threadId, injection.serverName, signal);
}

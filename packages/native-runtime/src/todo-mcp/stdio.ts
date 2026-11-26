import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TodoServiceClient } from "./todo-service-client";
import { TODO_EXECUTION_INSTRUCTIONS, TODO_TOOLS, TODO_TOOL_INSTRUCTIONS, todoToolOperation } from "./tool-definitions";
export function createTodoMcpServer(client: Pick<TodoServiceClient, "call">, scope: string) {
  const allowed = scope === "execution" ? TODO_TOOLS.filter(t => ["todo_get", "todo_report_execution"].includes(t.name)) : TODO_TOOLS.filter(t => t.name !== "todo_report_execution");
  const server = new Server({ name: "agentroam-todo", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: scope === "execution" ? TODO_EXECUTION_INSTRUCTIONS : TODO_TOOL_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allowed }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (!allowed.some(t => t.name === request.params.name)) throw new Error("Tool not permitted by this credential");
      const { operation, args } = todoToolOperation(request.params.name, request.params.arguments ?? {});
      const result = await client.call(operation, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : "Todo operation failed", code: (error as { code?: string })?.code }) }] }; }
  });
  return server;
}
export async function runTodoMcpStdio(options: { serviceId: string; descriptorPath?: string; deferServiceCheck?: boolean }): Promise<void> {
  const descriptorPath = options.descriptorPath ?? process.env.AGENTROAM_TODO_DESCRIPTOR;
  if (!descriptorPath) throw new Error("A scoped Todo credential descriptor is required");
  const client = new TodoServiceClient({ serviceId: options.serviceId, descriptorPath });
  // Interactive sessions can advertise tools from the local manage descriptor.
  // Every tool call still discovers and authenticates the Todo service.
  const useLocalScope = options.deferServiceCheck && (await client.credential()).scope === "manage";
  const scope = useLocalScope ? "manage" : (await client.call("identity")).scope;
  if (scope !== "manage" && scope !== "execution") throw new Error("Runtime relay credentials cannot open MCP");
  await createTodoMcpServer(client, scope).connect(new StdioServerTransport());
}

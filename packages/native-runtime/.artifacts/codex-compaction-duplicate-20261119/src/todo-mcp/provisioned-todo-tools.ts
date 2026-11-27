import { z } from "zod";
import { readFile } from "node:fs/promises";
import { TodoServiceClient } from "./todo-service-client";
import { TODO_TOOLS, todoToolOperation } from "./tool-definitions";
/** TUI and other embedded loops must opt into an explicit service descriptor;
 * their working directory never selects the user's Todo database. */
export async function provisionedTodoTools(descriptorPath?: string, registry?: string) {
  if (!descriptorPath) return [];
  const { serviceId } = JSON.parse(await readFile(descriptorPath, "utf8"));
  const client = new TodoServiceClient({ serviceId, descriptorPath, registry });
  const identity = await client.call("identity");
  if (!["manage", "execution"].includes(identity.scope)) throw new Error("Runtime relay credentials cannot provide Todo tools");
  const tools = TODO_TOOLS.filter(t => identity.scope === "execution" ? ["todo_get", "todo_report_execution"].includes(t.name) : t.name !== "todo_report_execution");
  return tools.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema, schema: z.record(z.unknown()), networkAccess: "write" as const,
    async execute(input: Record<string, unknown>) { try { const call = todoToolOperation(t.name, input); return { toolCallId: "", content: JSON.stringify(await client.call(call.operation, call.args)) }; } catch (error) { return { toolCallId: "", content: error instanceof Error ? error.message : String(error), isError: true }; } },
  }));
}

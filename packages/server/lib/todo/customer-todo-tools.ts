import { z } from "zod";
import { type ITool, type ToolContext } from "@agent/core";
import { TODO_TOOLS, todoToolOperation } from "@agent/native-runtime";
import { todoServices } from "./todo-service";
import { anonymousPrincipal } from "../web-auth/anonymous";
import { resolveAgentTodoCommand, type AgentTodoCommand } from "./todo-agent-command";
export function customerTodoTools(enabledTools?: readonly string[]): ITool[] {
  return TODO_TOOLS.filter(t => t.name !== "todo_report_execution" && (!enabledTools?.length || enabledTools.includes(t.name) || enabledTools.includes("agentroam-todo"))).map(t => ({
    name: t.name, description: t.description, parameters: t.inputSchema, schema: z.record(z.unknown()),
    authorization: "direct" as const, networkAccess: "none" as const,
    async execute(input: Record<string, unknown>, context: ToolContext) {
      try {
        const ownerId = anonymousPrincipal().userId, { operation, args } = todoToolOperation(t.name, input), service = todoServices();
        let result: unknown;
        if (operation === "get") result = service.todos.get(String(input.taskId), ownerId);
        else if (operation === "list") result = service.todos.list(input, ownerId);
        else {
          const command = await resolveAgentTodoCommand((args as { command: AgentTodoCommand }).command, {
            sessionId: context.sessionId, cwd: context.workingDirectory, getTodo: id => service.todos.get(id, ownerId),
          });
          result = service.todos.execute(command, { ownerId, requestId: String(input.requestId ?? ""), sourceSessionRef: context.sessionId });
        }
        return { toolCallId: "", content: JSON.stringify(result), isError: false };
      } catch (error) { return { toolCallId: "", content: error instanceof Error ? error.message : String(error), isError: true }; }
    },
  }));
}

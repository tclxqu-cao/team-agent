import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';

export class DispatchAgentTool implements ITool {
  readonly name = "dispatch_agent";
  readonly description =
    "Dispatch a task to another agent by name. The agent will execute the task and return its result. " +
    "Use this to delegate specialized work to agents with specific capabilities or personas. " +
    "The dispatched agent runs in the same session context so it can see prior history. " +
    "Always use todo_add first to plan tasks before dispatching.";
  readonly schema = z.object({
    agentName: z.string().describe("Name of the agent to dispatch to (must match agent name exactly)"),
    task: z.string().describe("The specific task or instructions for the agent"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      agentName: { type: "string", description: "Name of the agent to dispatch to" },
      task: { type: "string", description: "The specific task or instructions for the agent" },
    },
    required: ["agentName", "task"],
  };

  constructor(
    private readonly dispatchFn: (
      agentName: string,
      task: string,
      sessionId: string,
    ) => Promise<string>,
  ) {}

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: `Invalid params: ${parsed.error.message}`, isError: true };
    }
    try {
      const result = await this.dispatchFn(parsed.data.agentName, parsed.data.task, ctx.sessionId);
      return { toolCallId: "", content: result };
    } catch (err) {
      return {
        toolCallId: "",
        content: `Failed to dispatch to agent "${parsed.data.agentName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        isError: true,
      };
    }
  }
}

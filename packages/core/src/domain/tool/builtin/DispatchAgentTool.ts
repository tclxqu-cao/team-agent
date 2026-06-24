import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';

export interface DispatchResult {
  status: "running" | "completed" | "failed";
  agentName: string;
  subSessionId: string;
  summary?: string;
  error?: string;
}

export class DispatchAgentTool implements ITool {
  readonly name = "dispatch_agent";
  readonly description =
    "Dispatch a task to another agent by name. The agent will execute the task and return its result. " +
    "Use this to delegate specialized work to agents with specific capabilities or personas. " +
    "The dispatched agent runs in the same session context so it can see prior history. " +
    "Always use todo_add first to plan tasks before dispatching.\n\n" +
    "Returns a JSON object with: status (\"completed\"|\"failed\"), agentName, subSessionId, " +
    "summary (on success), and error (on failure).";
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
    ) => Promise<DispatchResult>,
  ) {}

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: JSON.stringify({
        status: "failed",
        agentName: "",
        subSessionId: "",
        error: `Invalid params: ${parsed.error.message}`,
      }), isError: true };
    }
    const result = await this.dispatchFn(parsed.data.agentName, parsed.data.task, ctx.sessionId);
    return {
      toolCallId: "",
      content: JSON.stringify(result),
      isError: result.status === "failed",
    };
  }
}

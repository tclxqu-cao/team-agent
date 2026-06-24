import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import type { DispatchResult } from './DispatchAgentTool.js';

export class WaitAgentTool implements ITool {
  readonly name = "wait_agent";
  readonly description =
    "Wait for a previously dispatched sub-agent to complete. " +
    "Blocks until the agent finishes or the timeout is reached. " +
    "Returns a JSON object with the sub-agent's result: " +
    'status ("completed"|"failed"), agentName, subSessionId, summary (on success), and error (on failure).';
  readonly schema = z.object({
    subSessionId: z.string().describe("The subSessionId returned by dispatch_agent"),
    timeoutMs: z.number().optional().describe("Maximum time to wait in milliseconds (default: 60000)"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      subSessionId: { type: "string", description: "The subSessionId returned by dispatch_agent" },
      timeoutMs: { type: "number", description: "Maximum time to wait in milliseconds (default: 60000)", optional: true },
    },
    required: ["subSessionId"],
  };

  constructor(
    private readonly waitFn: (subSessionId: string, timeoutMs?: number) => Promise<DispatchResult>,
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
    const { subSessionId, timeoutMs } = parsed.data;
    const result = await this.waitFn(subSessionId, timeoutMs);
    return {
      toolCallId: "",
      content: JSON.stringify(result),
      isError: result.status === "failed",
    };
  }
}

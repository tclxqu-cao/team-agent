import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from "../entities.js";
import type { DispatchResult } from "./DispatchAgentTool.js";

export interface SpawnAgentInput {
  name: string;
  role: string;
  task: string;
  instructions?: string;
}

export class SpawnAgentTool implements ITool {
  readonly name = "spawn_agent";
  readonly description =
    "Create a temporary specialist agent for the current task. The child runs in a separate " +
    "session with server-controlled capabilities and cannot create more agents. Spawn independent " +
    "specialists in parallel when useful, then call wait_agent with each returned subSessionId " +
    "before producing the final answer.";
  readonly schema = z.object({
    name: z.string().trim().min(1).max(80).describe("Short display name for the temporary specialist"),
    role: z.string().trim().min(1).max(500).describe("The specialist's responsibility and expertise"),
    task: z.string().trim().min(1).max(8_000).describe("The concrete task delegated to the specialist"),
    instructions: z.string().trim().max(8_000).optional().describe("Additional execution instructions"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      name: { type: "string", description: "Short display name", maxLength: 80 },
      role: { type: "string", description: "Responsibility and expertise", maxLength: 500 },
      task: { type: "string", description: "Concrete delegated task", maxLength: 8_000 },
      instructions: { type: "string", description: "Additional execution instructions", maxLength: 8_000 },
    },
    required: ["name", "role", "task"],
  };

  constructor(
    private readonly spawnFn: (
      input: SpawnAgentInput,
      parentSessionId: string,
    ) => Promise<DispatchResult>,
  ) {}

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return {
        toolCallId: "",
        content: JSON.stringify({
          status: "failed",
          agentName: "",
          subSessionId: "",
          code: "INVALID_SPAWN_REQUEST",
          error: `Invalid params: ${parsed.error.message}`,
        }),
        isError: true,
      };
    }
    const result = await this.spawnFn(parsed.data, ctx.sessionId);
    return {
      toolCallId: "",
      content: JSON.stringify(result),
      isError: result.status === "failed",
    };
  }
}

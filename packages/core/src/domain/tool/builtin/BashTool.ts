import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import { execSync } from "node:child_process";

export class BashTool implements ITool {
  readonly name = "bash";
  readonly description = "Execute a bash command in the working directory";
  readonly schema = z.object({
    command: z.string().describe("The bash command to execute"),
    timeout: z.number().optional().default(120000).describe("Timeout in milliseconds"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
    },
    required: ["command"],
  };

  async execute(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return {
        toolCallId: "",
        content: `Invalid parameters: ${parsed.error.message}`,
        isError: true,
      };
    }

    try {
      const output = execSync(parsed.data.command, {
        cwd: ctx.workingDirectory,
        timeout: parsed.data.timeout,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      return { toolCallId: "", content: output || "(no output)" };
    } catch (err) {
      if (err instanceof Error && "stdout" in err) {
        const execErr = err as unknown as { stdout: string; stderr: string; message: string };
        return {
          toolCallId: "",
          content: execErr.stderr || execErr.message,
          isError: true,
        };
      }
      return {
        toolCallId: "",
        content: err instanceof Error ? err.message : "Command execution failed",
        isError: true,
      };
    }
  }
}

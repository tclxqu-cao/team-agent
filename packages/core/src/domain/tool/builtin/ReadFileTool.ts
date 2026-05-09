import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export class ReadFileTool implements ITool {
  readonly name = "read_file";
  readonly description = "Read the contents of a file at the given path";
  readonly schema = z.object({
    file_path: z.string().describe("The absolute path to the file to read"),
    offset: z.number().optional().describe("Line number to start reading from"),
    limit: z.number().optional().describe("Maximum number of lines to read"),
  });
  readonly parameters = this.schemaToParams();

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
      const filePath = resolve(ctx.workingDirectory, parsed.data.file_path);
      let content = await readFile(filePath, "utf-8");

      if (parsed.data.offset || parsed.data.limit) {
        const lines = content.split("\n");
        const start = (parsed.data.offset ?? 1) - 1;
        const end = parsed.data.limit ? start + parsed.data.limit : undefined;
        content = lines.slice(start, end).join("\n");
      }

      return { toolCallId: "", content };
    } catch (err) {
      return {
        toolCallId: "",
        content: err instanceof Error ? err.message : "Failed to read file",
        isError: true,
      };
    }
  }

  private schemaToParams(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The absolute path to the file to read" },
        offset: { type: "number", description: "Line number to start reading from" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["file_path"],
    };
  }
}

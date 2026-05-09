import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export class WriteFileTool implements ITool {
  readonly name = "write_file";
  readonly description = "Write content to a file at the given path";
  readonly schema = z.object({
    file_path: z.string().describe("The absolute path to the file to write"),
    content: z.string().describe("The content to write to the file"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The absolute path to the file to write" },
      content: { type: "string", description: "The content to write to the file" },
    },
    required: ["file_path", "content"],
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
      const filePath = resolve(ctx.workingDirectory, parsed.data.file_path);
      await writeFile(filePath, parsed.data.content, "utf-8");
      return { toolCallId: "", content: `File written: ${filePath}` };
    } catch (err) {
      return {
        toolCallId: "",
        content: err instanceof Error ? err.message : "Failed to write file",
        isError: true,
      };
    }
  }
}

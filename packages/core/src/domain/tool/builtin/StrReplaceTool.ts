import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export class StrReplaceTool implements ITool {
  readonly name = "str_replace";
  readonly description = `Replace an exact string in a file with new content.
Use this instead of write_file when making targeted edits to existing files.
The old_string must match the file content EXACTLY (including whitespace and indentation).
Include 2-3 lines of context before and after to uniquely identify the target location.
If old_string appears multiple times, use more context to make it unique.`;

  readonly schema = z.object({
    file_path: z.string().describe("Absolute path to the file to edit"),
    old_string: z.string().describe("The exact string to find and replace. Must be unique in the file."),
    new_string: z.string().describe("The replacement string"),
  });

  readonly parameters = {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to edit" },
      old_string: { type: "string", description: "The exact string to find and replace. Must be unique in the file." },
      new_string: { type: "string", description: "The replacement string" },
    },
    required: ["file_path", "old_string", "new_string"],
  };

  async execute(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: `Invalid parameters: ${parsed.error.message}`, isError: true };
    }

    const { file_path, old_string, new_string } = parsed.data;

    try {
      const filePath = resolve(ctx.workingDirectory, file_path);
      const content = await readFile(filePath, "utf-8");

      const count = content.split(old_string).length - 1;
      if (count === 0) {
        return {
          toolCallId: "",
          content: `Error: old_string not found in ${file_path}. Make sure the string matches exactly (including whitespace and indentation).`,
          isError: true,
        };
      }
      if (count > 1) {
        return {
          toolCallId: "",
          content: `Error: old_string matches ${count} locations in ${file_path}. Add more surrounding context to make it unique.`,
          isError: true,
        };
      }

      const updated = content.replace(old_string, new_string);
      await writeFile(filePath, updated, "utf-8");

      // Show a compact diff summary
      const oldLines = old_string.split("\n").length;
      const newLines = new_string.split("\n").length;
      return {
        toolCallId: "",
        content: `Replaced in ${file_path} (${oldLines} line${oldLines !== 1 ? "s" : ""} → ${newLines} line${newLines !== 1 ? "s" : ""})`,
      };
    } catch (err) {
      return {
        toolCallId: "",
        content: err instanceof Error ? err.message : "Failed to edit file",
        isError: true,
      };
    }
  }
}

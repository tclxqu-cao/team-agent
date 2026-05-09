import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join, relative } from "node:path";

export class GrepTool implements ITool {
  readonly name = "grep";
  readonly description = "Search for a keyword or regex pattern in files. Returns matching lines with file path and line number.";
  readonly schema = z.object({
    pattern: z.string().describe("The search pattern (string or regex)"),
    path: z.string().optional().describe("File or directory to search in (defaults to working directory)"),
    recursive: z.boolean().optional().describe("Search recursively in directories (default: true)"),
    case_sensitive: z.boolean().optional().describe("Case-sensitive search (default: false)"),
    include: z.string().optional().describe("Glob-style file extension filter, e.g. '.ts' or '.ts,.js'"),
    max_results: z.number().optional().describe("Maximum number of matching lines to return (default: 50)"),
  });
  readonly parameters = this.schemaToParams();

  async execute(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: `Invalid parameters: ${parsed.error.message}`, isError: true };
    }

    const {
      pattern,
      path: searchPath = ".",
      recursive = true,
      case_sensitive = false,
      include,
      max_results = 50,
    } = parsed.data;

    const absPath = resolve(ctx.workingDirectory, searchPath);

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, case_sensitive ? "g" : "gi");
    } catch {
      return { toolCallId: "", content: `Invalid regex pattern: ${pattern}`, isError: true };
    }

    const extensions = include
      ? include.split(",").map((e) => e.trim().replace(/^\*?\.?/, "."))
      : null;

    const results: string[] = [];

    const searchFile = async (filePath: string) => {
      if (results.length >= max_results) return;
      try {
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n");
        const relPath = relative(ctx.workingDirectory, filePath);
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= max_results) break;
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      } catch {
        // skip unreadable files
      }
    };

    const walk = async (dir: string) => {
      if (results.length >= max_results) return;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= max_results) break;
        if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
        const full = join(dir, entry);
        const s = await stat(full).catch(() => null);
        if (!s) continue;
        if (s.isDirectory()) {
          if (recursive) await walk(full);
        } else {
          if (!extensions || extensions.some((ext) => entry.endsWith(ext))) {
            await searchFile(full);
          }
        }
      }
    };

    try {
      const s = await stat(absPath);
      if (s.isFile()) {
        await searchFile(absPath);
      } else {
        await walk(absPath);
      }

      if (results.length === 0) {
        return { toolCallId: "", content: `No matches found for "${pattern}"` };
      }

      const header = `Found ${results.length}${results.length >= max_results ? "+" : ""} match(es) for "${pattern}":\n\n`;
      return { toolCallId: "", content: header + results.join("\n") };
    } catch (err) {
      return {
        toolCallId: "",
        content: err instanceof Error ? err.message : "Search failed",
        isError: true,
      };
    }
  }

  private schemaToParams(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The search pattern (string or regex)" },
        path: { type: "string", description: "File or directory to search in (defaults to working directory)" },
        recursive: { type: "boolean", description: "Search recursively in directories (default: true)" },
        case_sensitive: { type: "boolean", description: "Case-sensitive search (default: false)" },
        include: { type: "string", description: "File extension filter, e.g. '.ts' or '.ts,.js'" },
        max_results: { type: "number", description: "Maximum number of matching lines to return (default: 50)" },
      },
      required: ["pattern"],
    };
  }
}

import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';
import { readdir, stat } from "node:fs/promises";
import { resolve, join, relative } from "node:path";

/** Convert a glob pattern to a RegExp. Supports **, *, ?, {a,b}, and [abc]. */
function globToRegex(pattern: string): RegExp {
  let src = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // **  → matches any sequence including path separators
        src += ".*";
        i += 2;
        // skip optional trailing slash
        if (pattern[i] === "/") i++;
      } else {
        // *   → matches anything except /
        src += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      src += "[^/]";
      i++;
    } else if (ch === "{") {
      // {a,b,c} → (a|b|c)
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        src += "\\{";
        i++;
      } else {
        const alts = pattern.slice(i + 1, end).split(",").map(globToRegexPart);
        src += `(?:${alts.join("|")})`;
        i = end + 1;
      }
    } else if ("[]*+.^$|()\\".includes(ch) && ch !== "[") {
      src += "\\" + ch;
      i++;
    } else {
      src += ch;
      i++;
    }
  }
  return new RegExp(`^${src}$`);
}

function globToRegexPart(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[^/]*");
}

const DEFAULT_IGNORE = new Set(["node_modules", ".git", "dist", ".next", "build", "__pycache__", ".cache"]);

export class GlobTool implements ITool {
  readonly name = "glob";
  readonly description =
    "List files matching a glob pattern (e.g. **/*.ts, src/**/*.{ts,tsx}, *.md). " +
    "Returns matching paths relative to the search root. " +
    "node_modules, .git, dist, and .next are excluded by default.";

  readonly schema = z.object({
    pattern: z.string().describe("Glob pattern, e.g. '**/*.ts', 'src/**/*.{ts,tsx}', '*.md'"),
    path: z.string().optional().describe("Directory to search in (default: working directory)"),
    max_results: z.number().int().positive().optional().describe("Maximum number of results to return (default: 200)"),
    include_hidden: z.boolean().optional().describe("Include hidden files/dirs starting with '.' (default: false)"),
  });

  readonly parameters = this.schemaToParams();

  private schemaToParams(): Record<string, unknown> {
    const shape = (this.schema as z.ZodObject<z.ZodRawShape>).shape;
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(shape)) {
      const def = (val as z.ZodTypeAny)._def;
      const desc = def.description ?? "";
      const inner = def.innerType ?? val;
      const typeName: string = inner._def?.typeName ?? def.typeName ?? "";
      let type = "string";
      if (typeName === "ZodNumber") type = "number";
      else if (typeName === "ZodBoolean") type = "boolean";
      props[key] = { type, description: desc };
    }
    return {
      type: "object",
      properties: props,
      required: ["pattern"],
    };
  }

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = this.schema.safeParse(params);
    if (!parsed.success) {
      return { toolCallId: "", content: `Invalid parameters: ${parsed.error.message}`, isError: true };
    }

    const { pattern, path: searchPath = ".", max_results = 200, include_hidden = false } = parsed.data;
    const root = resolve(ctx.workingDirectory, searchPath);

    let regex: RegExp;
    try {
      regex = globToRegex(pattern);
    } catch {
      return { toolCallId: "", content: `Invalid glob pattern: ${pattern}`, isError: true };
    }

    const matches: string[] = [];

    const walk = async (dir: string) => {
      if (matches.length >= max_results) return;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (matches.length >= max_results) break;
        if (!include_hidden && entry.startsWith(".")) continue;
        if (DEFAULT_IGNORE.has(entry)) continue;

        const fullPath = join(dir, entry);
        let s;
        try {
          s = await stat(fullPath);
        } catch {
          continue;
        }

        const relPath = relative(root, fullPath);

        if (s.isDirectory()) {
          await walk(fullPath);
        } else {
          if (regex.test(relPath)) {
            matches.push(relPath);
          }
        }
      }
    };

    await walk(root);

    if (matches.length === 0) {
      return { toolCallId: "", content: `No files found matching pattern '${pattern}' in ${searchPath}` };
    }

    const lines = matches.sort();
    const truncated = lines.length >= max_results ? `\n(results truncated at ${max_results})` : "";
    return {
      toolCallId: "",
      content: lines.join("\n") + truncated,
    };
  }
}

import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';

export class WebSearchTool implements ITool {
  readonly name = "web_search";
  readonly description = "Search the web for information using DuckDuckGo HTML";
  readonly schema = z.object({
    query: z.string().min(2).describe("The search query"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
    },
    required: ["query"],
  };

  async execute(
    params: Record<string, unknown>,
    _ctx: ToolContext,
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
      const response = await fetch(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(parsed.data.query)}`,
        {
          headers: { "User-Agent": "customer-agent/0.1" },
          signal: AbortSignal.timeout(15000),
        },
      );

      if (!response.ok) {
        return {
          toolCallId: "",
          content: `Search failed: HTTP ${response.status}`,
          isError: true,
        };
      }

      const html = await response.text();
      const results = this.parseResults(html);
      return {
        toolCallId: "",
        content: results.length > 0
          ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`).join("\n\n")
          : "No results found.",
      };
    } catch (err) {
      return {
        toolCallId: "",
        content: err instanceof Error ? err.message : "Search failed",
        isError: true,
      };
    }
  }

  private parseResults(html: string): Array<{ title: string; snippet: string; url: string }> {
    const results: Array<{ title: string; snippet: string; url: string }> = [];
    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(html)) !== null) {
      const url = linkMatch[1];
      const title = linkMatch[2].replace(/<[^>]+>/g, "").trim();
      if (url && title) {
        results.push({ title, url, snippet: "" });
      }
    }

    let snippetMatch: RegExpExecArray | null;
    let i = 0;
    while ((snippetMatch = snippetRegex.exec(html)) !== null && i < results.length) {
      results[i].snippet = snippetMatch[1].replace(/<[^>]+>/g, "").trim();
      i++;
    }

    return results.slice(0, 10);
  }
}

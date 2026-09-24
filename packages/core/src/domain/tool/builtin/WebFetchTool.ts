import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';

export class WebFetchTool implements ITool {
  readonly name = "web_fetch";
  readonly networkAccess = "read" as const;
  readonly description = "Fetch content from a URL and process into markdown";
  readonly schema = z.object({
    url: z.string().url().describe("The URL to fetch content from"),
    prompt: z.string().describe("What information to extract from the page"),
  });
  readonly parameters = {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch content from" },
      prompt: { type: "string", description: "What information to extract from the page" },
    },
    required: ["url", "prompt"],
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
      const response = await fetch(parsed.data.url, {
        headers: {
          "User-Agent": "customer-agent/0.1",
          Accept: "text/html, application/xhtml+xml",
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return {
          toolCallId: "",
          content: `HTTP ${response.status}: ${response.statusText}`,
          isError: true,
        };
      }

      const html = await response.text();
      const text = this.stripHtml(html);
      const truncated = text.slice(0, 50000);

      return {
        toolCallId: "",
        content: `Content from ${parsed.data.url}:\n\n${truncated}`,
      };
    } catch (err) {
      return {
        toolCallId: "",
        content: err instanceof Error ? err.message : "Failed to fetch URL",
        isError: true,
      };
    }
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

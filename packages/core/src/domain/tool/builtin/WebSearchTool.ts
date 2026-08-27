import { z } from "zod";
import type { ITool, ToolContext, ToolResult } from '../entities.js';

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "Search failed";
  const cause = (err as { cause?: unknown }).cause;
  const causeMsg =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return causeMsg ? `${err.message}: ${causeMsg}` : err.message;
}

/** Bing result links are redirects; the real URL is base64 in the `u` param. */
function decodeBingRedirect(href: string): string {
  const decoded = decodeEntities(href);
  const u = /[?&]u=([^&]+)/.exec(decoded)?.[1];
  if (u && u.length > 2) {
    try {
      const b64 = u.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const real = atob(b64);
      if (/^https?:\/\//.test(real)) return real;
    } catch {
      // fall through to the raw href
    }
  }
  return decoded;
}

export class WebSearchTool implements ITool {
  readonly name = "web_search";
  readonly description =
    "Search the web for information using DuckDuckGo HTML, falling back to Bing";
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

    const errors: string[] = [];
    let anySourceResponded = false;
    for (const search of [this.searchDuckDuckGo, this.searchBing]) {
      try {
        const results = await search.call(this, parsed.data.query);
        anySourceResponded = true;
        if (results.length > 0) {
          return {
            toolCallId: "",
            content: results
              .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`)
              .join("\n\n"),
          };
        }
      } catch (err) {
        errors.push(describeError(err));
      }
    }

    if (!anySourceResponded && errors.length > 0) {
      return {
        toolCallId: "",
        content: `Search failed: ${errors.join(" | ")}`,
        isError: true,
      };
    }
    return { toolCallId: "", content: "No results found." };
  }

  private async searchDuckDuckGo(query: string): Promise<SearchResult[]> {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: { "User-Agent": "customer-agent/0.1" },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      throw new Error(`DuckDuckGo HTTP ${response.status}`);
    }
    return this.parseDuckDuckGoResults(await response.text());
  }

  private async searchBing(query: string): Promise<SearchResult[]> {
    const response = await fetch(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      {
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      throw new Error(`Bing HTTP ${response.status}`);
    }
    return this.parseBingResults(await response.text());
  }

  private parseDuckDuckGoResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(html)) !== null) {
      const url = linkMatch[1];
      const title = decodeEntities(stripTags(linkMatch[2])).trim();
      if (url && title) {
        results.push({ title, url, snippet: "" });
      }
    }

    let snippetMatch: RegExpExecArray | null;
    let i = 0;
    while ((snippetMatch = snippetRegex.exec(html)) !== null && i < results.length) {
      results[i].snippet = decodeEntities(stripTags(snippetMatch[1])).trim();
      i++;
    }

    return results.slice(0, 10);
  }

  private parseBingResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const blockRegex = /<li class="b_algo"[\s\S]*?<\/li>/gi;

    let block: RegExpExecArray | null;
    while ((block = blockRegex.exec(html)) !== null && results.length < 10) {
      const chunk = block[0];
      const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
      if (!link) continue;
      const title = decodeEntities(stripTags(link[2])).trim();
      const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/.exec(chunk);
      const snippet = snippetMatch
        ? decodeEntities(stripTags(snippetMatch[1])).trim()
        : "";
      const url = decodeBingRedirect(link[1]);
      if (url && title) {
        results.push({ title, snippet, url });
      }
    }

    return results;
  }
}

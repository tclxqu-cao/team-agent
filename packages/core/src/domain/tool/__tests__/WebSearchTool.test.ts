import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSearchTool } from '../builtin/WebSearchTool.js';

const CTX = { workingDirectory: ".", sessionId: "t", signal: new AbortController().signal } as any;

function ddgHtml(): string {
  return [
    '<a rel="nofollow" class="result__a" href="https://example.com/ddg">Example &amp; Title</a>',
    '<a class="result__snippet">DDG snippet</a>',
  ].join("");
}

// base64 of "https://cordis.com/" with Bing's 2-char redirect prefix
const bingHtml =
  '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;u=a1aHR0cHM6Ly9jb3JkaXMuY29tLw&amp;ntb=1">' +
  "Welcome to <strong>Cordis</strong></a></h2><p>Bing snippet</p></li>";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebSearchTool", () => {
  it("returns DuckDuckGo results when the primary source works", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => ddgHtml(),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WebSearchTool().execute({ query: "cordis" }, CTX);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Example & Title");
    expect(result.content).toContain("https://example.com/ddg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to Bing and decodes redirect URLs when DuckDuckGo fails", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: new Error("ECONNRESET") }))
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => bingHtml });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WebSearchTool().execute({ query: "cordis" }, CTX);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("www.bing.com/search");
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Welcome to Cordis");
    expect(result.content).toContain("Bing snippet");
    expect(result.content).toContain("https://cordis.com/");
  });

  it("reports both underlying errors when every source fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: new Error("ENOTFOUND") }))
        .mockRejectedValueOnce(new Error("Bing HTTP 503")),
    );

    const result = await new WebSearchTool().execute({ query: "cordis" }, CTX);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("fetch failed: ENOTFOUND");
    expect(result.content).toContain("Bing HTTP 503");
  });

  it("returns a non-error notice when sources respond but find nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" }));

    const result = await new WebSearchTool().execute({ query: "cordis" }, CTX);

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("No results found.");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAICompatibleUrl, requestChatCompletionContent } from "./openai-compatible.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildOpenAICompatibleUrl", () => {
  it("adds the v1 prefix when the base URL does not include it", () => {
    expect(buildOpenAICompatibleUrl("http://localhost:20128", "/chat/completions"))
      .toBe("http://localhost:20128/v1/chat/completions");
  });

  it("does not duplicate an existing v1 prefix", () => {
    expect(buildOpenAICompatibleUrl("http://localhost:20128/v1/", "chat/completions"))
      .toBe("http://localhost:20128/v1/chat/completions");
  });

  it("normalizes surrounding whitespace", () => {
    expect(buildOpenAICompatibleUrl(" http://localhost:20128/v1/ ", " /images/generations "))
      .toBe("http://localhost:20128/v1/images/generations");
  });
});

describe("requestChatCompletionContent", () => {
  it("explicitly requests a non-streaming response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{\"title\":\"test\"}" } }],
    }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const content = await requestChatCompletionContent({
      baseUrl: "http://localhost:20128/v1",
      apiKey: "test-key",
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
    });

    expect(content).toBe("{\"title\":\"test\"}");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:20128/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"stream":false'),
      }),
    );
  });

  it("falls back to parsing an SSE response from incompatible gateways", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"{\\"title\\":"}}]}',
      'data: {"choices":[{"delta":{"content":"\\"test\\"}"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    })));

    await expect(requestChatCompletionContent({
      baseUrl: "http://localhost:20128",
      apiKey: "test-key",
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
    })).resolves.toBe('{"title":"test"}');
  });
});

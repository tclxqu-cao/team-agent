import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../AnthropicProvider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const streamResponse = (...events: unknown[]) => new Response([
  ...events.map((event) => `data: ${JSON.stringify(event)}`),
  "",
].join("\n\n"), { status: 200 });

describe("AnthropicProvider image observations", () => {
  it("applies the configured whole-request timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse({ type: "message_stop" })));
    const provider = new AnthropicProvider({
      apiKey: "test",
      modelId: "claude-test",
      baseUrl: "https://example.com",
      timeoutMs: 600_000,
    });

    for await (const _ of provider.streamChat([{ role: "user", content: "Hi" }])) { /* consume */ }

    expect(timeoutSpy).toHaveBeenCalledWith(600_000);
  });

  it("returns a stable error when the initial request times out", async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    const provider = new AnthropicProvider({
      apiKey: "test",
      modelId: "claude-test",
      baseUrl: "https://example.com",
      timeoutMs: 600_000,
    });
    const events = [];

    for await (const event of provider.streamChat([{ role: "user", content: "Hi" }])) events.push(event);

    expect(events).toEqual([{
      type: "error",
      code: "model_request_timeout",
      message: expect.stringContaining("Anthropic 单次请求超过 600 秒"),
    }]);
    expect(events.some((event) => event.type === "text_done")).toBe(false);
  });

  it("sends a base64 image user block after tool results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'data: {"type":"message_stop"}\n\n',
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AnthropicProvider({ apiKey: "test", modelId: "claude-test", baseUrl: "https://example.com" });

    for await (const _ of provider.streamChat([
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "computer", arguments: { action: "screenshot" } }] },
      { role: "tool", content: '{"source":"screenshot"}', toolCallId: "call-1", name: "computer" },
      { role: "user", content: "Visual observations from tool calls: call-1", images: ["data:image/jpeg;base64,YWJj"] },
    ])) { /* consume */ }

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "user", "user"]);
    expect(body.messages[2].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "YWJj" },
    });
  });

  it("streams thinking separately from answer text and ignores signatures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先分析，" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "再回答。" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "secret-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "最终答案" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    )));
    const provider = new AnthropicProvider({ apiKey: "test", modelId: "claude-test", baseUrl: "https://example.com" });
    const events = [];

    for await (const event of provider.streamChat([{ role: "user", content: "Hi" }])) events.push(event);

    expect(events).toEqual([
      { type: "reasoning_delta", text: "先分析，再回答。" },
      { type: "text_chunk", text: "最终答案" },
      { type: "text_done" },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-signature");
  });

  it("reports thinking-only max-token truncation without text completion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "尚未完成" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      { type: "message_stop" },
    )));
    const provider = new AnthropicProvider({ apiKey: "test", modelId: "claude-test", baseUrl: "https://example.com" });
    const events = [];

    for await (const event of provider.streamChat([{ role: "user", content: "Hi" }])) events.push(event);

    expect(events).toEqual([
      { type: "reasoning_delta", text: "尚未完成" },
      expect.objectContaining({ type: "error", message: expect.stringContaining("输出被截断") }),
    ]);
    expect(events.some((event) => event.type === "text_done")).toBe(false);
  });
});

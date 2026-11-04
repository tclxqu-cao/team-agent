import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../AnthropicProvider.js";
import { anthropicUsageFrames, collectEvents, fixtureResponse, usageEvents } from "./usage-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const streamResponse = (...events: unknown[]) => new Response([
  ...events.map((event) => `data: ${JSON.stringify(event)}`),
  "",
].join("\n\n"), { status: 200 });

describe("AnthropicProvider reported usage", () => {
  const createProvider = () => new AnthropicProvider({ apiKey: "test", modelId: "claude-test", baseUrl: "https://example.com" });

  it("merges start input/cache with final output once across byte-sliced SSE frames", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fixtureResponse([
      ": heartbeat", "event: message_start", "data: {malformed", ...anthropicUsageFrames,
    ], { chunkSize: 1, trailingNewline: false }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await collectEvents(createProvider())).toEqual([
      { type: "text_chunk", text: "你好" },
      { type: "usage", usage: { inputTokens: 33, outputTokens: 7, totalTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 3, source: "provider", coverage: "complete" } },
      { type: "text_done" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads a valid final usage JSON line without a trailing newline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixtureResponse([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
    ], { chunkSize: 3, trailingNewline: false })));
    expect(usageEvents(await collectEvents(createProvider()))).toEqual([{
      type: "usage", usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9, source: "provider", coverage: "complete" },
    }]);
  });

  it("retains real zero input/output/cache counters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixtureResponse([
      { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: "message_delta", usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ])));
    expect(usageEvents(await collectEvents(createProvider()))).toEqual([{
      type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, source: "provider", coverage: "complete" },
    }]);
  });

  it("counts cache-only input as real input without losing a genuine zero base", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixtureResponse([
      { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 12, cache_creation_input_tokens: 3 } } },
      { type: "message_delta", usage: { output_tokens: 4 } },
    ])));
    expect(usageEvents(await collectEvents(createProvider()))).toEqual([{
      type: "usage", usage: { inputTokens: 15, outputTokens: 4, totalTokens: 19, cacheReadTokens: 12, cacheWriteTokens: 3, source: "provider", coverage: "complete" },
    }]);
  });

  it.each([
    undefined, null, {}, [], 0,
    { input_tokens: 5 },
    { output_tokens: 3 },
    { input_tokens: -1, output_tokens: 3 },
    { input_tokens: "5", output_tokens: 3 },
    { input_tokens: 5, output_tokens: null },
    { input_tokens: 5, output_tokens: 1.5 },
    { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: -1 },
    { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: "2" },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
  ])("does not estimate usage for missing or invalid counters %j", async (usage) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixtureResponse([
      { type: "message_start", message: { usage } },
      { type: "message_stop" },
    ])));
    expect(await collectEvents(createProvider())).toEqual([{ type: "text_done" }]);
  });

  it("does not fabricate counters for non-usage content blocks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixtureResponse([
      { type: "content_block_delta", delta: { type: "text_delta", text: "OK" }, usage: { input_tokens: 5, output_tokens: 3 } },
      { type: "message_stop" },
    ])));
    expect(await collectEvents(createProvider())).toEqual([{ type: "text_chunk", text: "OK" }, { type: "text_done" }]);
  });

  it("retains known start usage as partial when no final output counter arrives", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixtureResponse([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 8 } } },
      { type: "message_delta", usage: { output_tokens: -1 } },
      { type: "message_stop" },
    ])));
    expect(usageEvents(await collectEvents(createProvider()))).toEqual([{
      type: "usage", usage: { inputTokens: 13, outputTokens: 0, totalTokens: 13, cacheReadTokens: 8, source: "provider", coverage: "partial" },
    }]);
  });

  it("retains final usage on max-token truncation and ignores duplicate snapshots", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixtureResponse([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 2 } } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8 } },
      { type: "message_delta", usage: { input_tokens: 0, output_tokens: 8, cache_creation_input_tokens: 0 } },
      { type: "message_stop" },
    ])));
    const events = await collectEvents(createProvider());
    expect(events).toEqual([
      expect.objectContaining({ type: "error", message: expect.stringContaining("输出被截断") }),
      { type: "usage", usage: { inputTokens: 7, outputTokens: 8, totalTokens: 15, cacheWriteTokens: 2, source: "provider", coverage: "complete" } },
    ]);
  });

  it("flushes known partial usage before a raw SSE error and emits it only once", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixtureResponse([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 8 } } },
      { type: "error", error: { message: "upstream overloaded" } },
      { type: "message_delta", usage: { output_tokens: 99 } },
    ])));
    expect(await collectEvents(createProvider())).toEqual([
      { type: "usage", usage: { inputTokens: 13, outputTokens: 0, totalTokens: 13, cacheReadTokens: 8, source: "provider", coverage: "partial" } },
      { type: "error", message: "upstream overloaded" },
    ]);
  });

  it("preserves known partial usage when the reader fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixtureResponse([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    ], { error: new Error("connection reset") })));
    expect(await collectEvents(createProvider())).toEqual([
      { type: "usage", usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5, source: "provider", coverage: "partial" } },
      { type: "error", message: "connection reset" },
    ]);
  });

  it("flushes known usage before the existing timeout error without waiting", async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fixtureResponse([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    ], { error })));
    expect(await collectEvents(createProvider())).toEqual([
      { type: "usage", usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5, source: "provider", coverage: "partial" } },
      expect.objectContaining({ type: "error", code: "model_request_timeout" }),
    ]);
  });

  it("does not leak usage into another request on the same provider instance", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(fixtureResponse(anthropicUsageFrames))
      .mockResolvedValueOnce(fixtureResponse([{ type: "message_stop" }])));
    const provider = createProvider();
    expect(usageEvents(await collectEvents(provider))).toHaveLength(1);
    expect(usageEvents(await collectEvents(provider))).toEqual([]);
  });

  it.each([401, 403, 429, 500, 503])("keeps the raw HTTP %i error with a stable code and no usage", async (status) => {
    const raw = '  {"error":{"message":"upstream failure"}}\n';
    const fetchMock = vi.fn().mockResolvedValue(new Response(raw, { status }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await collectEvents(createProvider())).toEqual([{
      type: "error", code: `MODEL_HTTP_${status}`, message: `Anthropic API error ${status}: ${raw}`,
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

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

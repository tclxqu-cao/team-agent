import { describe, expect, it } from "vitest";
import { ProviderUsage } from "../usage.js";

describe("ProviderUsage", () => {
  it.each([NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null])(
    "rejects non-token counters %s without emitting or poisoning known usage", (invalid) => {
      const empty = new ProviderUsage();
      empty.recordOpenAI({ prompt_tokens: invalid, completion_tokens: 3 });
      expect(empty.take(true)).toBeUndefined();
      empty.recordAnthropic({ input_tokens: 2, output_tokens: invalid });
      expect(empty.take(true, true)).toBeUndefined();

      const known = new ProviderUsage();
      known.recordOpenAI({ prompt_tokens: 2, completion_tokens: 3 });
      known.recordOpenAI({ prompt_tokens: invalid, completion_tokens: 999 });
      expect(known.take(true)?.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5, source: "provider", coverage: "complete" });
    },
  );

  it("requires explicit input and output instead of filling missing counters with zero", () => {
    const usage = new ProviderUsage();
    usage.recordOpenAI({ total_tokens: 12, prompt_tokens_details: { cached_tokens: 2 } });
    expect(usage.take(false)).toBeUndefined();
    usage.recordOpenAI({ prompt_tokens: 5 });
    expect(usage.take(false)).toBeUndefined();
    usage.recordOpenAI({ completion_tokens: 0 });
    expect(usage.take(false)?.usage).toEqual({ inputTokens: 5, outputTokens: 0, totalTokens: 5, cacheReadTokens: 2, source: "provider", coverage: "partial" });
  });

  it("does not emit again after the final snapshot has been taken", () => {
    const usage = new ProviderUsage();
    usage.recordOpenAI({ prompt_tokens: 5, completion_tokens: 2 });
    expect(usage.take(true)).toMatchObject({ type: "usage" });
    expect(usage.take(false)).toBeUndefined();
    usage.recordOpenAI({ prompt_tokens: 5, completion_tokens: 10 });
    expect(usage.take(true)).toBeUndefined();
  });

  it.each([NaN, Infinity, -1, "2", null])("rejects invalid cache subcounters %s", (invalid) => {
    const openAI = new ProviderUsage();
    openAI.recordOpenAI({ prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: invalid } });
    expect(openAI.take(true)).toBeUndefined();
    const deepSeek = new ProviderUsage();
    deepSeek.recordOpenAI({ prompt_tokens: 5, completion_tokens: 2, prompt_cache_hit_tokens: invalid });
    expect(deepSeek.take(true)).toBeUndefined();
    const anthropic = new ProviderUsage();
    anthropic.recordAnthropic({ input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: invalid });
    expect(anthropic.take(true, true)).toBeUndefined();
  });

  it("rejects overflow after including Anthropic cache components", () => {
    const usage = new ProviderUsage();
    usage.recordAnthropic({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0, cache_read_input_tokens: 1 });
    expect(usage.take(true, true)).toBeUndefined();
  });
});

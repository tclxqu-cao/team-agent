import type { TokenUsage } from "../../agent/entities.js";
import type { StreamEvent } from "../entities.js";

type UsageRecord = Record<string, unknown>;

/** Retry once only when the server explicitly rejects the usage option itself. */
export async function fetchWithUsageFallback(
  url: string,
  init: RequestInit,
  body: Record<string, unknown>,
): Promise<Response> {
  const response = await fetch(url, { ...init, body: JSON.stringify(body) });
  if ((response.status !== 400 && response.status !== 422) || body.stream_options === undefined) return response;

  const errorText = await response.clone().text().catch(() => "");
  const rejectsNamedOption = /\b(?:unsupported|unrecogni[sz]ed|unknown|unexpected|additional)(?:[ _-]+(?:request|keyword|argument|parameter|field|propert(?:y|ies)|option|supplied|provided)s?)*(?:\s+(?:are|is)\s+not\s+(?:allowed|permitted))?[\s:="'`(\[]*\b(?:stream_options|include_usage)\b/i;
  const namedOptionRejected = /\b(?:stream_options(?:\.include_usage)?|include_usage)\b[\s"'`)\]:,-]*(?:(?:is|are|was|were)\s+)?(?:an?\s+)?(?:unsupported|unrecogni[sz]ed|unknown|unexpected|not\s+(?:a\s+)?supported)\b/i;
  if (!rejectsNamedOption.test(errorText) && !namedOptionRejected.test(errorText)) return response;

  const fallbackBody = { ...body };
  delete fallbackBody.stream_options;
  return fetch(url, { ...init, body: JSON.stringify(fallbackBody) });
}

function asRecord(value: unknown): UsageRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UsageRecord
    : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function validFields(usage: UsageRecord, fields: string[]): boolean {
  return fields.every((field) => usage[field] === undefined || tokenCount(usage[field]) !== undefined);
}

function latestCount(previous: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return previous;
  // Counts within a request are cumulative snapshots, never deltas. Some
  // compatible streams repeat input counters as zero in later output updates.
  return previous === undefined ? next : Math.max(previous, next);
}

/** Collect one request's provider counters, then emit its final snapshot once. */
export class ProviderUsage {
  private inputTokens?: number;
  private outputTokens?: number;
  private cacheReadTokens?: number;
  private cacheWriteTokens?: number;
  private emitted = false;

  recordOpenAI(value: unknown): void {
    const usage = asRecord(value);
    if (!usage || !validFields(usage, ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens"])) return;
    const details = asRecord(usage.prompt_tokens_details);
    if (details && !validFields(details, ["cached_tokens"])) return;

    const inputTokens = latestCount(this.inputTokens, tokenCount(usage.prompt_tokens));
    const cacheReadTokens = latestCount(
      this.cacheReadTokens,
      latestCount(tokenCount(details?.cached_tokens), tokenCount(usage.prompt_cache_hit_tokens)),
    );
    if (inputTokens !== undefined && cacheReadTokens !== undefined && cacheReadTokens > inputTokens) return;
    this.inputTokens = inputTokens;
    this.outputTokens = latestCount(this.outputTokens, tokenCount(usage.completion_tokens));
    this.cacheReadTokens = cacheReadTokens;
  }

  /** Returns whether this frame supplies a valid output counter. */
  recordAnthropic(value: unknown): boolean {
    const usage = asRecord(value);
    if (!usage || !validFields(usage, [
      "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
    ])) return false;

    // Anthropic input_tokens excludes both cache reads and writes. Keep these
    // components separate until emission; later message_delta frames may omit
    // them or repeat them as zero.
    this.inputTokens = latestCount(this.inputTokens, tokenCount(usage.input_tokens));
    this.outputTokens = latestCount(this.outputTokens, tokenCount(usage.output_tokens));
    this.cacheReadTokens = latestCount(this.cacheReadTokens, tokenCount(usage.cache_read_input_tokens));
    this.cacheWriteTokens = latestCount(this.cacheWriteTokens, tokenCount(usage.cache_creation_input_tokens));
    return tokenCount(usage.output_tokens) !== undefined;
  }

  take(complete: boolean, includeCacheInInput = false): Extract<StreamEvent, { type: "usage" }> | undefined {
    if (this.emitted || this.inputTokens === undefined || this.outputTokens === undefined) return undefined;
    const inputTokens = this.inputTokens + (includeCacheInInput
      ? (this.cacheReadTokens ?? 0) + (this.cacheWriteTokens ?? 0)
      : 0);
    const totalTokens = inputTokens + this.outputTokens;
    if (!Number.isSafeInteger(totalTokens)) return undefined;

    const usage: TokenUsage = {
      inputTokens,
      outputTokens: this.outputTokens,
      totalTokens,
      ...(this.cacheReadTokens !== undefined ? { cacheReadTokens: this.cacheReadTokens } : {}),
      ...(this.cacheWriteTokens !== undefined ? { cacheWriteTokens: this.cacheWriteTokens } : {}),
      source: "provider",
      coverage: complete ? "complete" : "partial",
    };
    this.emitted = true;
    return { type: "usage", usage };
  }
}

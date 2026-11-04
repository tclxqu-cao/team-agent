import type { TokenUsage } from './entities.js';
import { normalizeTokenUsage } from './run-result.js';

export class RunUsageAccumulator {
  private requests = 0;
  private reportedRequests = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private hasCacheRead = false;
  private hasCacheWrite = false;
  private partial = false;
  private current?: TokenUsage;

  beginRequest(): void {
    this.current = undefined;
    this.requests++;
  }

  observe(usage: TokenUsage): void {
    const normalized = normalizeTokenUsage(usage);
    if (normalized) this.current = normalized;
  }

  finishRequest(): void {
    if (!this.current) return;
    this.reportedRequests++;
    this.inputTokens += this.current.inputTokens;
    this.outputTokens += this.current.outputTokens;
    if (this.current.cacheReadTokens !== undefined) {
      this.hasCacheRead = true;
      this.cacheReadTokens += this.current.cacheReadTokens;
    }
    if (this.current.cacheWriteTokens !== undefined) {
      this.hasCacheWrite = true;
      this.cacheWriteTokens += this.current.cacheWriteTokens;
    }
    this.partial ||= this.current.coverage === "partial";
    this.current = undefined;
  }

  markPartial(): void {
    this.partial = true;
  }

  snapshot(): TokenUsage | undefined {
    const reported = this.reportedRequests + Number(this.current !== undefined);
    if (!reported) return undefined;
    const inputTokens = this.inputTokens + (this.current?.inputTokens ?? 0);
    const outputTokens = this.outputTokens + (this.current?.outputTokens ?? 0);
    return normalizeTokenUsage({
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(this.hasCacheRead || this.current?.cacheReadTokens !== undefined
        ? { cacheReadTokens: this.cacheReadTokens + (this.current?.cacheReadTokens ?? 0) } : {}),
      ...(this.hasCacheWrite || this.current?.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: this.cacheWriteTokens + (this.current?.cacheWriteTokens ?? 0) } : {}),
      source: "provider",
      coverage: this.partial || this.current?.coverage === "partial" || reported !== this.requests ? "partial" : "complete",
    });
  }
}

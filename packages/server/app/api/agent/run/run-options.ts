export const DEFAULT_CUSTOMER_AGENT_MAX_ITERATIONS = 10;
export const DEFAULT_CUSTOMER_AGENT_MAX_TOKENS = 100_000;

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function normalizeCustomerAgentRunOptions(input: {
  maxIterations?: unknown;
  maxTokens?: unknown;
}): { maxIterations: number; maxTokens: number } {
  return {
    maxIterations: boundedInteger(input.maxIterations, DEFAULT_CUSTOMER_AGENT_MAX_ITERATIONS, 1, 50),
    maxTokens: boundedInteger(input.maxTokens, DEFAULT_CUSTOMER_AGENT_MAX_TOKENS, 8_000, 2_000_000),
  };
}

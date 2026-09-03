import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOMER_AGENT_MAX_ITERATIONS,
  DEFAULT_CUSTOMER_AGENT_MAX_TOKENS,
  normalizeCustomerAgentRunOptions,
} from "./run-options";

describe("normalizeCustomerAgentRunOptions", () => {
  it("uses server defaults when optional web settings are absent", () => {
    expect(normalizeCustomerAgentRunOptions({})).toEqual({
      maxIterations: DEFAULT_CUSTOMER_AGENT_MAX_ITERATIONS,
      maxTokens: DEFAULT_CUSTOMER_AGENT_MAX_TOKENS,
    });
  });

  it("clamps untrusted run limits to supported ranges", () => {
    expect(normalizeCustomerAgentRunOptions({ maxIterations: 99, maxTokens: 3_000_000 })).toEqual({
      maxIterations: 50,
      maxTokens: 2_000_000,
    });
    expect(normalizeCustomerAgentRunOptions({ maxIterations: 0, maxTokens: 1 })).toEqual({
      maxIterations: 1,
      maxTokens: 8_000,
    });
  });
});

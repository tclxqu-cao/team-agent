import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_AGENT_TYPES, type NativeAgentType } from "@agent/core";
import { ClaudeRuntimeAdapter } from "./claude-runtime-adapter.js";
import { CodexRuntimeAdapter } from "./codex-runtime-adapter.js";
import { DeepSeekHarnessRuntimeAdapter } from "./deepseek-harness-runtime-adapter.js";
import { OpenCodeRuntimeAdapter } from "./opencode-runtime-adapter.js";
import { StdioNativeRuntimeAdapter } from "./stdio-native-runtime-adapter.js";
import { createNativeRuntimeBrokerHostRuntime } from "./native-runtime-broker.js";

afterEach(() => vi.restoreAllMocks());

describe("broker host native runtime registration", () => {
  it("exposes every registered native Agent through the shared facade without launching a CLI", async () => {
    for (const Adapter of [CodexRuntimeAdapter, ClaudeRuntimeAdapter, DeepSeekHarnessRuntimeAdapter, OpenCodeRuntimeAdapter, StdioNativeRuntimeAdapter]) {
      vi.spyOn(Adapter.prototype, "health").mockImplementation(async function (this: { agentType: NativeAgentType }) {
        return { agentType: this.agentType, label: this.agentType, available: true };
      });
    }
    const models = vi.spyOn(StdioNativeRuntimeAdapter.prototype, "listModels").mockImplementation(async function (this: { agentType: NativeAgentType }) {
      return [{ id: `${this.agentType}-native-model`, providerID: this.agentType }];
    });
    const runtime = createNativeRuntimeBrokerHostRuntime();
    try {
      const health = await runtime.health();
      expect(health.map(entry => entry.agentType).sort()).toEqual([...NATIVE_AGENT_TYPES].sort());
      for (const agent of ["qoder", "zcode", "workbuddy"] as const) {
        await expect(runtime.listModels(agent)).resolves.toEqual([{ id: `${agent}-native-model`, providerID: agent }]);
      }
      expect(models).toHaveBeenCalledTimes(3);
      await expect(runtime.listModels("customer-agent")).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    } finally {
      await runtime.dispose();
    }
  });
});

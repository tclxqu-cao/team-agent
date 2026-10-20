import { describe, expect, it, vi } from "vitest";
import { startDictation } from "./speech";

describe("startDictation", () => {
  it("ends empty dictation and ignores a late startup failure after cancellation", async () => {
    let result: ((payload: { text: string; isFinal: boolean }) => void) | undefined;
    let resolveStart!: (value: { ok: boolean; reason?: string }) => void;
    const onEnd = vi.fn();
    const onError = vi.fn();
    const onFinal = vi.fn();
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { agentApi: {
      dictationStart: () => new Promise((resolve) => { resolveStart = resolve; }),
      dictationStop: async () => ({ ok: true }),
      onDictation: (callback: typeof result) => { result = callback; return () => { result = undefined; }; },
      onDictationError: () => () => undefined,
    } } });
    try {
      startDictation({ onInterim: vi.fn(), onFinal, onError, onEnd });
      result?.({ text: "", isFinal: true });
      resolveStart({ ok: false, reason: "late failure" });
      await Promise.resolve();
      expect(onEnd).toHaveBeenCalledOnce();
      expect(onFinal).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });

  it("uses native desktop dictation and completes with the final transcript", async () => {
    let onResult: ((payload: { text: string; isFinal: boolean }) => void) | null = null;
    const dictationStart = vi.fn(async () => ({ ok: true }));
    const onEnd = vi.fn();
    const onInterim = vi.fn();
    const onFinal = vi.fn();

    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      agentApi: {
        dictationStart,
        dictationStop: vi.fn(async () => ({ ok: true })),
        onDictation: (callback: typeof onResult) => {
          onResult = callback;
          return () => { onResult = null; };
        },
        onDictationError: () => () => undefined,
      },
    } });

    try {
      const handle = startDictation({ onInterim, onFinal, onEnd });
      await Promise.resolve();

      expect(handle).not.toBeNull();
      expect(dictationStart).toHaveBeenCalledOnce();

      onResult?.({ text: "帮我查", isFinal: false });
      expect(onInterim).toHaveBeenCalledWith("帮我查");

      onResult?.({ text: "帮我查订单", isFinal: true });
      expect(onFinal).toHaveBeenCalledWith("帮我查订单");
      expect(onEnd).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });
});

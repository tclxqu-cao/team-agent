import { describe, expect, it, vi } from "vitest";
import * as interruption from "./voice-interruption";

describe("interruptSpeech", () => {
  it("stops native and browser speech output", async () => {
    const ttsStop = vi.fn(async () => ({ ok: true }));
    const stopWebSpeech = vi.fn();
    const interruptSpeech = (interruption as unknown as {
      interruptSpeech?: (
        api: { ttsStop?: () => Promise<{ ok: boolean }> } | undefined,
        stopBrowserSpeech: () => void,
      ) => Promise<void>;
    }).interruptSpeech;

    expect(typeof interruptSpeech).toBe("function");
    await interruptSpeech?.({ ttsStop }, stopWebSpeech);
    expect(ttsStop).toHaveBeenCalledOnce();
    expect(stopWebSpeech).toHaveBeenCalledOnce();
  });

  it("waits for native playback to stop before resolving", async () => {
    let finishStop: (() => void) | undefined;
    const ttsStop = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      finishStop = () => resolve({ ok: true });
    }));
    const stopWebSpeech = vi.fn();
    let stopped = false;

    const interruptionDone = interruption.interruptSpeech({ ttsStop }, stopWebSpeech)
      .then(() => { stopped = true; });

    expect(stopWebSpeech).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    finishStop?.();
    await interruptionDone;
    expect(stopped).toBe(true);
  });
});

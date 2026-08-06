import { describe, expect, it, vi } from "vitest";
import * as interruption from "./voice-interruption";

describe("interruptSpeech", () => {
  it("stops native and browser speech output", () => {
    const ttsStop = vi.fn(async () => ({ ok: true }));
    const stopWebSpeech = vi.fn();
    const interruptSpeech = (interruption as unknown as {
      interruptSpeech?: (
        api: { ttsStop?: () => Promise<{ ok: boolean }> } | undefined,
        stopBrowserSpeech: () => void,
      ) => void;
    }).interruptSpeech;

    expect(typeof interruptSpeech).toBe("function");
    interruptSpeech?.({ ttsStop }, stopWebSpeech);
    expect(ttsStop).toHaveBeenCalledOnce();
    expect(stopWebSpeech).toHaveBeenCalledOnce();
  });
});

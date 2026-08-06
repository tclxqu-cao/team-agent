import { describe, expect, it } from "vitest";
import { getVoiceCaptureAction } from "./voice-capture-state";
import * as voiceState from "./voice-capture-state";

describe("getVoiceCaptureAction", () => {
  it("starts a new capture for the first transcript in conversation mode", () => {
    expect(getVoiceCaptureAction(false, true)).toBe("start");
  });

  it("appends partial transcripts while a capture is active", () => {
    expect(getVoiceCaptureAction(true, true)).toBe("append");
  });

  it("ignores speech outside capture and conversation mode", () => {
    expect(getVoiceCaptureAction(false, false)).toBe("ignore");
  });
});

describe("isWakeMatch", () => {
  const isWakeMatch = (voiceState as unknown as {
    isWakeMatch?: (heard: string, variants: readonly string[], isFinal: boolean) => boolean;
  }).isWakeMatch;
  const variants = ["小智", "小志", "小知"];

  it("accepts a final transcript truncated by one wake-word character", () => {
    expect(typeof isWakeMatch).toBe("function");
    expect(isWakeMatch?.("小", variants, true)).toBe(true);
  });

  it("does not accept the same prefix from a partial transcript", () => {
    expect(isWakeMatch?.("小", variants, false)).toBe(false);
  });

  it("does not accept a wake-word prefix embedded in ordinary speech", () => {
    expect(isWakeMatch?.("我小时候", variants, true)).toBe(false);
  });
});

describe("parseWakeTranscriptLine", () => {
  const parseWakeTranscriptLine = (voiceState as unknown as {
    parseWakeTranscriptLine?: (line: string) => { heard: string; isFinal: boolean } | null;
  }).parseWakeTranscriptLine;

  it("distinguishes partial and final recognition output", () => {
    expect(typeof parseWakeTranscriptLine).toBe("function");
    expect(parseWakeTranscriptLine?.("TEXT 你好小")).toEqual({ heard: "你好小", isFinal: false });
    expect(parseWakeTranscriptLine?.("FINAL 小")).toEqual({ heard: "小", isFinal: true });
    expect(parseWakeTranscriptLine?.("HB cycle=0")).toBeNull();
  });
});

describe("getWakeCommandSuffix", () => {
  const getWakeCommandSuffix = (voiceState as unknown as {
    getWakeCommandSuffix?: (heard: string, variants: readonly string[]) => string | null;
  }).getWakeCommandSuffix;
  const variants = ["小智", "小志", "小知"];

  it("keeps the growing command text after a repeated wake-word match", () => {
    expect(typeof getWakeCommandSuffix).toBe("function");
    expect(getWakeCommandSuffix?.("你好小智请回复收到", variants)).toBe("请回复收到");
  });

  it("returns null when the transcript contains no full wake variant", () => {
    expect(getWakeCommandSuffix?.("继续播放", variants)).toBeNull();
  });
});

describe("replaceWakeCommandSuffix", () => {
  const replaceWakeCommandSuffix = (voiceState as unknown as {
    replaceWakeCommandSuffix?: (current: string, suffix: string) => string;
  }).replaceWakeCommandSuffix;

  it("replaces a corrected growing suffix instead of concatenating fragments", () => {
    expect(typeof replaceWakeCommandSuffix).toBe("function");
    let current = "小";
    current = replaceWakeCommandSuffix?.(current, "") ?? current;
    current = replaceWakeCommandSuffix?.(current, "请") ?? current;
    current = replaceWakeCommandSuffix?.(current, "请回复收到") ?? current;
    expect(current).toBe("请回复收到");
  });
});

describe("shouldRestartWakeListener", () => {
  const shouldRestartWakeListener = (voiceState as unknown as {
    shouldRestartWakeListener?: (desired: boolean, suspended: boolean) => boolean;
  }).shouldRestartWakeListener;

  it("does not restart the microphone while TTS has suspended listening", () => {
    expect(typeof shouldRestartWakeListener).toBe("function");
    expect(shouldRestartWakeListener?.(true, true)).toBe(false);
    expect(shouldRestartWakeListener?.(true, false)).toBe(true);
  });
});

describe("getVoiceCaptureSilenceTimeout", () => {
  const getVoiceCaptureSilenceTimeout = (voiceState as unknown as {
    getVoiceCaptureSilenceTimeout?: (commandText: string) => number;
  }).getVoiceCaptureSilenceTimeout;

  it("waits through the next file-recognition cycle after a wake-only phrase", () => {
    expect(typeof getVoiceCaptureSilenceTimeout).toBe("function");
    expect(getVoiceCaptureSilenceTimeout?.("")).toBe(8000);
    expect(getVoiceCaptureSilenceTimeout?.("你在干什么")).toBe(3000);
  });
});

describe("shouldRearmWakeOnlyCapture", () => {
  const shouldRearmWakeOnlyCapture = (voiceState as unknown as {
    shouldRearmWakeOnlyCapture?: (capturing: boolean, isFinal: boolean, commandText: string) => boolean;
  }).shouldRearmWakeOnlyCapture;

  it("restarts the command wait window when the wake-only utterance becomes final", () => {
    expect(typeof shouldRearmWakeOnlyCapture).toBe("function");
    expect(shouldRearmWakeOnlyCapture?.(true, true, "")).toBe(true);
    expect(shouldRearmWakeOnlyCapture?.(true, false, "")).toBe(false);
    expect(shouldRearmWakeOnlyCapture?.(true, true, "你在干什么")).toBe(false);
  });
});

describe("shouldFinalizeVoiceCapture", () => {
  const shouldFinalizeVoiceCapture = (voiceState as unknown as {
    shouldFinalizeVoiceCapture?: (capturing: boolean, isFinal: boolean, commandText: string) => boolean;
  }).shouldFinalizeVoiceCapture;

  it("finalizes an active capture as soon as Speech returns a final result", () => {
    expect(typeof shouldFinalizeVoiceCapture).toBe("function");
    expect(shouldFinalizeVoiceCapture?.(true, true, "请回复收到")).toBe(true);
  });

  it("keeps partial or inactive captures open", () => {
    expect(shouldFinalizeVoiceCapture?.(true, false, "请回复收到")).toBe(false);
    expect(shouldFinalizeVoiceCapture?.(false, true, "请回复收到")).toBe(false);
  });

  it("keeps listening when a final transcript contains only the wake word", () => {
    expect(shouldFinalizeVoiceCapture?.(true, true, "")).toBe(false);
  });
});

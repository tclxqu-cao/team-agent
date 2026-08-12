import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

describe("TTS barge-in state", () => {
  const getTtsListeningMode = (voiceState as unknown as {
    getTtsListeningMode?: (conversation: boolean) => "barge-in" | "suspended";
  }).getTtsListeningMode;
  const shouldAcceptBargeIn = (voiceState as unknown as {
    shouldAcceptBargeIn?: (ttsSpeaking: boolean, conversation: boolean) => boolean;
  }).shouldAcceptBargeIn;

  it("keeps listening for barge-in only during voice-conversation TTS", () => {
    expect(typeof getTtsListeningMode).toBe("function");
    expect(getTtsListeningMode?.(true)).toBe("barge-in");
    expect(getTtsListeningMode?.(false)).toBe("suspended");
  });

  it("accepts barge-in only while a voice-conversation reply is speaking", () => {
    expect(typeof shouldAcceptBargeIn).toBe("function");
    expect(shouldAcceptBargeIn?.(true, true)).toBe(true);
    expect(shouldAcceptBargeIn?.(true, false)).toBe(false);
    expect(shouldAcceptBargeIn?.(false, true)).toBe(false);
    expect(shouldAcceptBargeIn?.(false, false)).toBe(false);
  });
});

describe("prepareTtsListening", () => {
  const prepareTtsListening = (voiceState as unknown as {
    prepareTtsListening?: (
      mode: "barge-in" | "suspended",
      currentMode: "wake" | "dictation" | "barge-in" | null,
      stop: () => void,
      launch: () => Promise<unknown>,
    ) => Promise<void>;
  }).prepareTtsListening;

  it("does not resolve until barge-in listening is ready", async () => {
    let markReady = () => {};
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const calls: string[] = [];

    const preparing = prepareTtsListening?.(
      "barge-in",
      "wake",
      () => calls.push("stop"),
      async () => {
        calls.push("launch");
        await ready;
      },
    ).then(() => calls.push("ready"));

    await Promise.resolve();
    expect(calls).toEqual(["stop", "launch"]);
    markReady();
    await preparing;
    expect(calls).toEqual(["stop", "launch", "ready"]);
  });
});

describe("parseWakeControlLine", () => {
  const parseWakeControlLine = (voiceState as unknown as {
    parseWakeControlLine?: (line: string) => "barge-in" | null;
  }).parseWakeControlLine;

  it("recognizes the barge-in control line without consuming transcripts", () => {
    expect(typeof parseWakeControlLine).toBe("function");
    expect(parseWakeControlLine?.("BARGE_IN")).toBe("barge-in");
    expect(parseWakeControlLine?.("FINAL 下一轮问题")).toBeNull();
  });
});

describe("native barge-in recording", () => {
  const source = readFileSync(
    new URL("../native/wakelistener.swift", import.meta.url),
    "utf8",
  );

  it("uses the strict VAD threshold only until barge-in has been confirmed", () => {
    expect(source).toContain(
      'let requiresBargeInOnset = recognitionMode == "barge-in" && !bargeInEmitted',
    );
    expect(source).toContain(
      "let threshold = requiresBargeInOnset ? bargeInSpeechPeakThreshold : speechPeakThreshold",
    );
    expect(source).toContain(
      "&& (!requiresBargeInOnset || bufferRms >= bargeInSpeechRmsThreshold)",
    );
  });
});

describe("routeVoiceServiceResult", () => {
  const routeVoiceServiceResult = (voiceState as unknown as {
    routeVoiceServiceResult?: (
      current: { sessionId: string; generation: number; lastFinalUtteranceId: number },
      event: { type: "keyword" | "partial" | "final"; sessionId: string; generation: number; utteranceId?: number },
    ) => { action: "ignore" | "keyword" | "partial" | "final"; lastFinalUtteranceId: number };
  }).routeVoiceServiceResult;

  it("rejects stale session and generation results", () => {
    const current = { sessionId: "voice-2", generation: 9, lastFinalUtteranceId: 1 };
    expect(typeof routeVoiceServiceResult).toBe("function");
    expect(routeVoiceServiceResult?.(current, {
      type: "partial", sessionId: "voice-1", generation: 9,
    })).toEqual({ action: "ignore", lastFinalUtteranceId: 1 });
    expect(routeVoiceServiceResult?.(current, {
      type: "final", sessionId: "voice-2", generation: 8, utteranceId: 2,
    })).toEqual({ action: "ignore", lastFinalUtteranceId: 1 });
  });

  it("submits each later utterance once for multi-turn conversation", () => {
    let current = { sessionId: "voice-2", generation: 9, lastFinalUtteranceId: 0 };
    const first = routeVoiceServiceResult?.(current, {
      type: "final", sessionId: "voice-2", generation: 9, utteranceId: 1,
    });
    expect(first).toEqual({ action: "final", lastFinalUtteranceId: 1 });
    current = { ...current, lastFinalUtteranceId: first?.lastFinalUtteranceId ?? 0 };
    expect(routeVoiceServiceResult?.(current, {
      type: "final", sessionId: "voice-2", generation: 9, utteranceId: 1,
    })).toEqual({ action: "ignore", lastFinalUtteranceId: 1 });
    expect(routeVoiceServiceResult?.(current, {
      type: "final", sessionId: "voice-2", generation: 9, utteranceId: 2,
    })).toEqual({ action: "final", lastFinalUtteranceId: 2 });
  });

  it("accepts only current keywords without changing final utterance deduplication", () => {
    const current = { sessionId: "voice-2", generation: 9, lastFinalUtteranceId: 4 };
    expect(routeVoiceServiceResult?.(current, {
      type: "keyword", sessionId: "voice-2", generation: 9,
    })).toEqual({ action: "keyword", lastFinalUtteranceId: 4 });
    expect(routeVoiceServiceResult?.(current, {
      type: "keyword", sessionId: "voice-2", generation: 8,
    })).toEqual({ action: "ignore", lastFinalUtteranceId: 4 });
  });
});

describe("shouldAcceptTtsPlayback", () => {
  const shouldAcceptTtsPlayback = (voiceState as unknown as {
    shouldAcceptTtsPlayback?: (
      resultGeneration: number,
      currentGeneration: number,
      speaking: boolean,
    ) => boolean;
  }).shouldAcceptTtsPlayback;

  it("rejects synthesized audio after barge-in or a newer reply", () => {
    expect(typeof shouldAcceptTtsPlayback).toBe("function");
    expect(shouldAcceptTtsPlayback?.(4, 4, true)).toBe(true);
    expect(shouldAcceptTtsPlayback?.(3, 4, true)).toBe(false);
    expect(shouldAcceptTtsPlayback?.(4, 4, false)).toBe(false);
  });
});

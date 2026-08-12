import { describe, expect, it } from "vitest";
import { parseAsrControl, parseTtsRequest } from "./protocol";

describe("parseAsrControl", () => {
  it("accepts a 16 kHz ASR start message", () => {
    expect(parseAsrControl(JSON.stringify({
      type: "start",
      sessionId: "voice-1",
      generation: 7,
      sampleRate: 16_000,
      mode: "wake",
      wakeWord: "小智",
    }))).toEqual({
      type: "start",
      sessionId: "voice-1",
      generation: 7,
      sampleRate: 16_000,
      mode: "wake",
      wakeWord: "小智",
    });
  });

  it.each(["reset", "finish", "stop"] as const)("accepts %s controls", (type) => {
    expect(parseAsrControl(JSON.stringify({
      type,
      sessionId: "voice-1",
      generation: 8,
    }))).toEqual({ type, sessionId: "voice-1", generation: 8 });
  });

  it.each([
    [{ type: "start", sessionId: "", generation: 1, sampleRate: 16_000, mode: "wake" }, "sessionId"],
    [{ type: "start", sessionId: "v", generation: -1, sampleRate: 16_000, mode: "wake" }, "generation"],
    [{ type: "start", sessionId: "v", generation: 1, sampleRate: 48_000, mode: "wake" }, "sampleRate"],
    [{ type: "start", sessionId: "v", generation: 1, sampleRate: 16_000, mode: "unknown" }, "mode"],
    [{ type: "start", sessionId: "v", generation: 1, sampleRate: 16_000, mode: "wake", wakeWord: 1 }, "wakeWord"],
  ])("rejects invalid ASR control %#", (value, field) => {
    expect(() => parseAsrControl(JSON.stringify(value))).toThrow(String(field));
  });
});

describe("parseTtsRequest", () => {
  it("applies the default Chinese voice and speed", () => {
    expect(parseTtsRequest({
      sessionId: "voice-1",
      generation: 12,
      text: "这是本轮回答。",
    })).toEqual({
      sessionId: "voice-1",
      generation: 12,
      text: "这是本轮回答。",
      voice: "default-zh-female",
      speed: 1,
    });
  });

  it.each([
    [{ sessionId: "v", generation: 1, text: "" }, "text"],
    [{ sessionId: "v", generation: 1, text: "字".repeat(601) }, "600"],
    [{ sessionId: "v", generation: 1, text: "你好", speed: 0.49 }, "speed"],
    [{ sessionId: "v", generation: 1, text: "你好", speed: 2.01 }, "speed"],
  ])("rejects invalid TTS request %#", (value, message) => {
    expect(() => parseTtsRequest(value)).toThrow(String(message));
  });
});

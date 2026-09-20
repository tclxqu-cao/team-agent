import { describe, expect, it } from "vitest";
import { pcmToWav } from "../src/voice/gateway.js";

describe("pcmToWav", () => {
  it("生成正确的 24kHz mono 16bit WAV 头", () => {
    const pcm = Buffer.alloc(4800, 0x7f); // 100ms @24kHz
    const wav = pcmToWav(pcm);
    expect(wav.length).toBe(44 + 4800);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24_000); // sampleRate
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    expect(wav.readUInt32LE(40)).toBe(4800); // data size
    expect(wav.readUInt32LE(4)).toBe(36 + 4800);
  });
});

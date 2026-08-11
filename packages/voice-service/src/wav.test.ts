import { describe, expect, it } from "vitest";
import { encodeFloat32Wav } from "./wav";

describe("encodeFloat32Wav", () => {
  it("writes a mono IEEE-float WAV with literal lengths and rates", () => {
    const wav = encodeFloat32Wav(new Float32Array([0.25, -0.5]), 24_000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(44);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(3);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(28)).toBe(96_000);
    expect(wav.readUInt16LE(32)).toBe(4);
    expect(wav.readUInt16LE(34)).toBe(32);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(8);
    expect(wav.readFloatLE(44)).toBe(0.25);
    expect(wav.readFloatLE(48)).toBe(-0.5);
  });
});

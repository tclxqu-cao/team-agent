import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findAsrModelFiles, findTtsModelFiles } from "./model-files";

describe("findAsrModelFiles", () => {
  it("returns the four Zipformer files from a real directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-asr-"));
    for (const name of ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"]) {
      writeFileSync(join(dir, name), name);
    }
    expect(findAsrModelFiles(dir)).toEqual({
      encoder: join(dir, "encoder.int8.onnx"),
      decoder: join(dir, "decoder.onnx"),
      joiner: join(dir, "joiner.int8.onnx"),
      tokens: join(dir, "tokens.txt"),
    });
  });

  it("reports every missing model component", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-asr-"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "encoder.int8.onnx"), "encoder");
    expect(() => findAsrModelFiles(dir)).toThrow("decoder, joiner, tokens");
  });
});

describe("findTtsModelFiles", () => {
  it("finds Melo VITS model, tokens, lexicon, and dictionary data", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-tts-"));
    writeFileSync(join(dir, "model.onnx"), "model");
    writeFileSync(join(dir, "tokens.txt"), "tokens");
    writeFileSync(join(dir, "lexicon.txt"), "lexicon");
    mkdirSync(join(dir, "dict"));
    expect(findTtsModelFiles(dir)).toEqual({
      model: join(dir, "model.onnx"),
      tokens: join(dir, "tokens.txt"),
      lexicon: join(dir, "lexicon.txt"),
      dataDir: join(dir, "dict"),
    });
  });
});

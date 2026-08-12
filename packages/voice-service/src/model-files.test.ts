import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findAsrModelFiles, findKwsModelFiles, findTtsModelFiles } from "./model-files";

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

describe("findKwsModelFiles", () => {
  it("prefers int8 KWS files and returns the keyword tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-kws-"));
    for (const name of [
      "encoder-epoch-12.onnx",
      "encoder-epoch-12.int8.onnx",
      "decoder-epoch-12.onnx",
      "joiner-epoch-12.onnx",
      "joiner-epoch-12.int8.onnx",
      "tokens.txt",
      "keywords.txt",
    ]) {
      writeFileSync(join(dir, name), name);
    }
    expect(findKwsModelFiles(dir)).toEqual({
      encoder: join(dir, "encoder-epoch-12.int8.onnx"),
      decoder: join(dir, "decoder-epoch-12.onnx"),
      joiner: join(dir, "joiner-epoch-12.int8.onnx"),
      tokens: join(dir, "tokens.txt"),
      keywords: join(dir, "keywords.txt"),
    });
  });

  it("does not mix components when the archive contains multiple epochs", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-kws-"));
    for (const name of [
      "encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
      "decoder-epoch-99-avg-1-chunk-16-left-64.onnx",
      "joiner-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
      "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
      "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      "tokens.txt",
      "keywords.txt",
    ]) {
      writeFileSync(join(dir, name), name);
    }
    expect(findKwsModelFiles(dir)).toMatchObject({
      encoder: join(dir, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
      decoder: join(dir, "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
      joiner: join(dir, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
    });
  });

  it("rejects a directory without one complete matching model set", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-kws-"));
    for (const name of [
      "encoder-epoch-99-avg-1.int8.onnx",
      "decoder-epoch-12-avg-2.onnx",
      "joiner-epoch-12-avg-2.int8.onnx",
      "tokens.txt",
      "keywords.txt",
    ]) {
      writeFileSync(join(dir, name), name);
    }
    expect(() => findKwsModelFiles(dir)).toThrow("matching encoder, decoder, joiner");
  });

  it("reports every missing KWS component", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-kws-"));
    writeFileSync(join(dir, "encoder.int8.onnx"), "encoder");
    expect(() => findKwsModelFiles(dir)).toThrow("decoder, joiner, tokens, keywords");
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
      dictDir: join(dir, "dict"),
    });
  });
});

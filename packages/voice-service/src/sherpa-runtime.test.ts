import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAsrRecognizerConfig,
  buildKwsConfig,
  buildTtsConfig,
  createSherpaEngines,
  type SherpaAddonLike,
} from "./sherpa-runtime";

function modelDirectories(): { asr: string; kws: string; tts: string } {
  const root = mkdtempSync(join(tmpdir(), "voice-models-"));
  const asr = join(root, "asr");
  const kws = join(root, "kws");
  const tts = join(root, "tts");
  mkdirSync(asr);
  mkdirSync(kws);
  mkdirSync(tts);
  for (const name of ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"]) {
    writeFileSync(join(asr, name), name);
  }
  for (const name of ["model.onnx", "tokens.txt", "lexicon.txt"]) writeFileSync(join(tts, name), name);
  for (const name of [
    "encoder.int8.onnx",
    "decoder.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
    "keywords.txt",
  ]) writeFileSync(join(kws, name), name);
  mkdirSync(join(tts, "dict"));
  return { asr, kws, tts };
}

describe("sherpa runtime configuration", () => {
  it("builds the pinned streaming Zipformer configuration", () => {
    expect(buildAsrRecognizerConfig({
      encoder: "/asr/encoder.int8.onnx",
      decoder: "/asr/decoder.onnx",
      joiner: "/asr/joiner.int8.onnx",
      tokens: "/asr/tokens.txt",
    })).toEqual({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: "/asr/encoder.int8.onnx",
          decoder: "/asr/decoder.onnx",
          joiner: "/asr/joiner.int8.onnx",
        },
        tokens: "/asr/tokens.txt",
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 0.8,
      rule3MinUtteranceLength: 20,
    });
  });

  it("builds the dedicated WenetSpeech KWS configuration", () => {
    expect(buildKwsConfig({
      encoder: "/kws/encoder.int8.onnx",
      decoder: "/kws/decoder.onnx",
      joiner: "/kws/joiner.int8.onnx",
      tokens: "/kws/tokens.txt",
      keywords: "/kws/keywords.txt",
    })).toEqual({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: "/kws/encoder.int8.onnx",
          decoder: "/kws/decoder.onnx",
          joiner: "/kws/joiner.int8.onnx",
        },
        tokens: "/kws/tokens.txt",
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
      maxActivePaths: 4,
      numTrailingBlanks: 1,
      keywordsScore: 1,
      keywordsThreshold: 0.25,
      keywordsFile: "/kws/keywords.txt",
    });
  });

  it("builds the Melo VITS configuration", () => {
    expect(buildTtsConfig({
      model: "/tts/model.onnx",
      tokens: "/tts/tokens.txt",
      lexicon: "/tts/lexicon.txt",
      dictDir: "/tts/dict",
    })).toEqual({
      model: {
        vits: {
          model: "/tts/model.onnx",
          tokens: "/tts/tokens.txt",
          lexicon: "/tts/lexicon.txt",
          dataDir: "",
          dictDir: "/tts/dict",
        },
      },
      maxNumSentences: 1,
      silenceScale: 0.2,
      numThreads: 2,
      provider: "cpu",
    });
  });

  it("loads ASR once and degrades KWS and TTS independently", async () => {
    const dirs = modelDirectories();
    const recognizer = {
      createStream: () => ({ acceptWaveform() {}, inputFinished() {} }),
      isReady: () => false,
      decode() {},
      getResult: () => ({ text: "" }),
      isEndpoint: () => false,
      reset() {},
    };
    let asrLoads = 0;
    const addon: SherpaAddonLike = {
      OnlineRecognizer: class {
        constructor() {
          asrLoads += 1;
          return recognizer;
        }
      } as any,
      KeywordSpotter: class {
        constructor() { throw new Error("kws unavailable"); }
      } as any,
      OfflineTts: {
        async createAsync() { throw new Error("tts unavailable"); },
      },
    };
    const engines = await createSherpaEngines(addon, dirs.asr, dirs.kws, dirs.tts);
    expect(asrLoads).toBe(1);
    expect(engines.asr).toBeDefined();
    expect(engines.kws).toBeNull();
    expect(engines.kwsError?.message).toBe("kws unavailable");
    expect(engines.tts).toBeNull();
    expect(engines.ttsError?.message).toBe("tts unavailable");
  });
});

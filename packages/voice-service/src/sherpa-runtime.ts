import type { AsrModelFiles, KwsModelFiles, TtsModelFiles } from "./model-files.js";
import { findAsrModelFiles, findKwsModelFiles, findTtsModelFiles } from "./model-files.js";
import { AsrEngine, type RecognizerLike } from "./asr-engine.js";
import { KwsEngine, type KeywordSpotterLike } from "./kws-engine.js";
import { TtsEngine, type OfflineTtsLike } from "./tts-engine.js";

export interface SherpaAddonLike {
  OnlineRecognizer: new (config: ReturnType<typeof buildAsrRecognizerConfig>) => RecognizerLike;
  KeywordSpotter: new (config: ReturnType<typeof buildKwsConfig>) => KeywordSpotterLike;
  OfflineTts: {
    createAsync(config: ReturnType<typeof buildTtsConfig>): Promise<OfflineTtsLike>;
  };
  version?: string;
}

export function buildKwsConfig(files: KwsModelFiles) {
  return {
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: files.encoder,
        decoder: files.decoder,
        joiner: files.joiner,
      },
      tokens: files.tokens,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: 1,
    keywordsThreshold: 0.25,
    keywordsFile: files.keywords,
  };
}

export function buildAsrRecognizerConfig(files: AsrModelFiles) {
  return {
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: files.encoder,
        decoder: files.decoder,
        joiner: files.joiner,
      },
      tokens: files.tokens,
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
  };
}

export function buildTtsConfig(files: TtsModelFiles) {
  return {
    model: {
      vits: {
        model: files.model,
        tokens: files.tokens,
        lexicon: files.lexicon,
        dataDir: "",
        dictDir: files.dictDir,
      },
    },
    maxNumSentences: 1,
    silenceScale: 0.2,
    numThreads: 2,
    provider: "cpu",
  };
}

export async function createSherpaEngines(
  addon: SherpaAddonLike,
  asrModelDir: string,
  kwsModelDir: string,
  ttsModelDir: string,
): Promise<{
  asr: AsrEngine;
  kws: KwsEngine | null;
  kwsError: Error | null;
  tts: TtsEngine | null;
  ttsError: Error | null;
}> {
  const recognizer = new addon.OnlineRecognizer(
    buildAsrRecognizerConfig(findAsrModelFiles(asrModelDir)),
  );
  const asr = new AsrEngine(recognizer);
  let kws: KwsEngine | null = null;
  let kwsError: Error | null = null;
  try {
    const spotter = new addon.KeywordSpotter(
      buildKwsConfig(findKwsModelFiles(kwsModelDir)),
    );
    kws = new KwsEngine(spotter);
  } catch (error) {
    kwsError = error instanceof Error ? error : new Error(String(error));
  }
  try {
    const offline = await addon.OfflineTts.createAsync(
      buildTtsConfig(findTtsModelFiles(ttsModelDir)),
    );
    return { asr, kws, kwsError, tts: new TtsEngine(offline), ttsError: null };
  } catch (error) {
    return {
      asr,
      kws,
      kwsError,
      tts: null,
      ttsError: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

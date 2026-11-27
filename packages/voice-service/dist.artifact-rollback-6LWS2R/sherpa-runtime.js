import { findAsrModelFiles, findKwsModelFiles } from "./model-files.js";
import { AsrEngine } from "./asr-engine.js";
import { KwsEngine } from "./kws-engine.js";
export function buildKwsConfig(files) {
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
export function buildAsrRecognizerConfig(files) {
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
export async function createSherpaEngines(addon, asrModelDir, kwsModelDir) {
    const recognizer = new addon.OnlineRecognizer(buildAsrRecognizerConfig(findAsrModelFiles(asrModelDir)));
    const asr = new AsrEngine(recognizer);
    let kws = null;
    let kwsError = null;
    try {
        const spotter = new addon.KeywordSpotter(buildKwsConfig(findKwsModelFiles(kwsModelDir)));
        kws = new KwsEngine(spotter);
    }
    catch (error) {
        kwsError = error instanceof Error ? error : new Error(String(error));
    }
    return { asr, kws, kwsError };
}
//# sourceMappingURL=sherpa-runtime.js.map
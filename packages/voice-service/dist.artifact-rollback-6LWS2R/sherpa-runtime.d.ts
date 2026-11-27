import type { AsrModelFiles, KwsModelFiles } from "./model-files.js";
import { AsrEngine, type RecognizerLike } from "./asr-engine.js";
import { KwsEngine, type KeywordSpotterLike } from "./kws-engine.js";
export interface SherpaAddonLike {
    OnlineRecognizer: new (config: ReturnType<typeof buildAsrRecognizerConfig>) => RecognizerLike;
    KeywordSpotter: new (config: ReturnType<typeof buildKwsConfig>) => KeywordSpotterLike;
    version?: string;
}
export declare function buildKwsConfig(files: KwsModelFiles): {
    featConfig: {
        sampleRate: number;
        featureDim: number;
    };
    modelConfig: {
        transducer: {
            encoder: string;
            decoder: string;
            joiner: string;
        };
        tokens: string;
        numThreads: number;
        provider: string;
        debug: number;
    };
    maxActivePaths: number;
    numTrailingBlanks: number;
    keywordsScore: number;
    keywordsThreshold: number;
    keywordsFile: string;
};
export declare function buildAsrRecognizerConfig(files: AsrModelFiles): {
    featConfig: {
        sampleRate: number;
        featureDim: number;
    };
    modelConfig: {
        transducer: {
            encoder: string;
            decoder: string;
            joiner: string;
        };
        tokens: string;
        numThreads: number;
        provider: string;
        debug: number;
    };
    decodingMethod: string;
    maxActivePaths: number;
    enableEndpoint: boolean;
    rule1MinTrailingSilence: number;
    rule2MinTrailingSilence: number;
    rule3MinUtteranceLength: number;
};
export declare function createSherpaEngines(addon: SherpaAddonLike, asrModelDir: string, kwsModelDir: string): Promise<{
    asr: AsrEngine;
    kws: KwsEngine | null;
    kwsError: Error | null;
}>;
//# sourceMappingURL=sherpa-runtime.d.ts.map
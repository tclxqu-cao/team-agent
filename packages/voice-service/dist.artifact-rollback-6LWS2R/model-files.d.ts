export interface AsrModelFiles {
    encoder: string;
    decoder: string;
    joiner: string;
    tokens: string;
}
export interface KwsModelFiles extends AsrModelFiles {
    keywords: string;
}
export declare function findAsrModelFiles(modelDir: string): AsrModelFiles;
export declare function findKwsModelFiles(modelDir: string): KwsModelFiles;
//# sourceMappingURL=model-files.d.ts.map
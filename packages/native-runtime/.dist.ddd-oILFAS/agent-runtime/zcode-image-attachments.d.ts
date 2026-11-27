import { type ParsedImageDataUrl } from "./image-input.js";
export interface ZCodeImageAttachment {
    kind: "image";
    filename: string;
    mimeType: string;
    sizeBytes: number;
    localPath: string;
}
/** Native file parts use artifact URLs; our retained upload is the preview source. */
export declare function readZCodeHistoryImages(value: unknown, storageRoot: string): Promise<Map<string, string>>;
/** Local paths keep multiple photos below the native NDJSON frame limit.
 * Retain accepted/uncertain sends because native history may still reference them. */
export declare function persistZCodeImageAttachments(images: readonly ParsedImageDataUrl[], storageRoot: string): Promise<ZCodeImageAttachment[]>;
//# sourceMappingURL=zcode-image-attachments.d.ts.map
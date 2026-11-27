export declare const MAX_IMAGE_BYTES: number;
export type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export interface ParsedImageDataUrl {
    mimeType: SupportedImageMimeType;
    extension: "jpg" | "png" | "gif" | "webp";
    base64: string;
    bytes: Buffer;
}
export declare function parseImageDataUrls(images: readonly string[] | undefined): ParsedImageDataUrl[];
//# sourceMappingURL=image-input.d.ts.map
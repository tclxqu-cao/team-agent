/** Formats that can be opened natively as a browser document. */
export function supportsArtifactBrowserPreview(path) {
    return /\.(html?|pdf|png|jpe?g|gif|webp|bmp|ico|svg|mp4|webm|mp3|wav|ogg|txt)$/i.test(path);
}
//# sourceMappingURL=artifact-preview-types.js.map
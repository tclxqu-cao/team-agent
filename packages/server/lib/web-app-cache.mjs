/** Only content-addressed assets can outlive the HTML that selected them. */
export function webAppCacheControl(relativePath) {
  return /^assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|json|svg|png|jpe?g|gif|webp|ico|woff2?|map)$/.test(relativePath)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

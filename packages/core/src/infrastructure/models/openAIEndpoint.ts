/** Accept an API origin, a versioned API base, or a full completion endpoint. */
export function openAIEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/chat/completions") ? path
    : `${path.endsWith("/v1") ? path : `${path}/v1`}/chat/completions`;
  return url.toString();
}

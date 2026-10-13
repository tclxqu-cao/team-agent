export const WEBAPP_ARTIFACT_OPEN_TYPE = "agent-webapp:artifact-open:v1";

export interface WebArtifactOpenRequest {
  type: typeof WEBAPP_ARTIFACT_OPEN_TYPE;
  requestId: number;
  path: string;
}

/** Remote media stays in the browser; it is never fetched by the host file service. */
export function isWebMediaUrl(value: string): boolean {
  if (/[\0\r\n]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && /\.(mp4|webm|mov|m4v|mp3|wav|m4a|aac|ogg|flac|png|jpe?g|gif|webp|pdf)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

export function parseWebArtifactOpenRequest(data: unknown): WebArtifactOpenRequest | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== WEBAPP_ARTIFACT_OPEN_TYPE) return null;
  if (!Number.isSafeInteger(candidate.requestId) || Number(candidate.requestId) < 1) return null;
  if (
    typeof candidate.path !== "string"
    || !(isAbsoluteHostPath(candidate.path) || candidate.path.startsWith("~/") || isWebMediaUrl(candidate.path))
    || candidate.path.includes("\0")
    || candidate.path.includes("\n")
    || candidate.path.includes("\r")
  ) return null;
  return candidate as unknown as WebArtifactOpenRequest;
}

export function readWebArtifactOpenRequest(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  expectedOrigin: string,
  expectedSource: MessageEventSource | null,
): WebArtifactOpenRequest | null {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return null;
  return parseWebArtifactOpenRequest(event.data);
}

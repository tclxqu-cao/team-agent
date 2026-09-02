export const WEBAPP_PROJECT_REQUEST_TYPE = "agent-webapp:project-request:v1";
export const WEBAPP_PROJECT_RESPONSE_TYPE = "agent-web-shell:project-response:v1";

export const WEB_PROJECT_METHODS = [
  "project:list",
  "project:get",
  "project:create",
  "project:rename",
  "project:delete",
  "project:roots",
  "project:directories",
  "project:check",
] as const;

export type WebProjectMethod = typeof WEB_PROJECT_METHODS[number];

export interface WebProjectRequest {
  type: typeof WEBAPP_PROJECT_REQUEST_TYPE;
  id: number;
  method: WebProjectMethod;
  payload: Record<string, unknown>;
}

export interface WebProjectResponse {
  type: typeof WEBAPP_PROJECT_RESPONSE_TYPE;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

const methodSet = new Set<string>(WEB_PROJECT_METHODS);

export function parseWebProjectRequest(data: unknown): WebProjectRequest | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== WEBAPP_PROJECT_REQUEST_TYPE) return null;
  if (!Number.isSafeInteger(candidate.id) || Number(candidate.id) < 1) return null;
  if (typeof candidate.method !== "string" || !methodSet.has(candidate.method)) return null;
  if (!candidate.payload || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)) return null;
  return candidate as unknown as WebProjectRequest;
}

export function readWebProjectRequest(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  expectedOrigin: string,
  expectedSource: MessageEventSource | null,
): WebProjectRequest | null {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return null;
  return parseWebProjectRequest(event.data);
}

export function parseWebProjectResponse(data: unknown): WebProjectResponse | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== WEBAPP_PROJECT_RESPONSE_TYPE) return null;
  if (!Number.isSafeInteger(candidate.id) || Number(candidate.id) < 1) return null;
  if (typeof candidate.ok !== "boolean") return null;
  if (!candidate.ok && typeof candidate.error !== "string") return null;
  return candidate as unknown as WebProjectResponse;
}

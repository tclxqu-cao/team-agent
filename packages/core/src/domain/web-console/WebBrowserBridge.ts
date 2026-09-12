export const WEBAPP_BROWSER_REQUEST_TYPE = "agent-webapp:browser-request:v1";
export const WEBAPP_BROWSER_RESPONSE_TYPE = "agent-web-shell:browser-response:v1";
export const WEBAPP_BROWSER_EVENT_TYPE = "agent-web-shell:browser-event:v1";
export const WEBAPP_BROWSER_BINARY_FRAME_TYPE = "agent-web-shell:browser-frame:v1";

export const WEB_BROWSER_METHODS = [
  "browser:list",
  "browser:watch",
  "browser:unwatch",
  "browser:takeover",
  "browser:return",
  "browser:input",
  "browser:webrtc",
] as const;

export type WebBrowserMethod = typeof WEB_BROWSER_METHODS[number];

export interface WebBrowserRequest {
  type: typeof WEBAPP_BROWSER_REQUEST_TYPE;
  id: number;
  method: WebBrowserMethod;
  payload: Record<string, unknown>;
}

export interface WebBrowserResponse {
  type: typeof WEBAPP_BROWSER_RESPONSE_TYPE;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

export interface WebBrowserEvent {
  type: typeof WEBAPP_BROWSER_EVENT_TYPE;
  event: Record<string, unknown> & { type: string };
}

export interface WebBrowserBinaryFrame {
  type: typeof WEBAPP_BROWSER_BINARY_FRAME_TYPE;
  channelId: number;
  sequence: number;
  data: ArrayBuffer;
}

const methodSet = new Set<string>(WEB_BROWSER_METHODS);

export function parseWebBrowserRequest(data: unknown): WebBrowserRequest | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== WEBAPP_BROWSER_REQUEST_TYPE) return null;
  if (!Number.isSafeInteger(candidate.id) || Number(candidate.id) < 1) return null;
  if (typeof candidate.method !== "string" || !methodSet.has(candidate.method)) return null;
  if (!candidate.payload || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)) return null;
  return candidate as unknown as WebBrowserRequest;
}

export function readWebBrowserRequest(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  expectedOrigin: string,
  expectedSource: MessageEventSource | null,
): WebBrowserRequest | null {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return null;
  return parseWebBrowserRequest(event.data);
}

export function parseWebBrowserResponse(data: unknown): WebBrowserResponse | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== WEBAPP_BROWSER_RESPONSE_TYPE) return null;
  if (!Number.isSafeInteger(candidate.id) || Number(candidate.id) < 1) return null;
  if (typeof candidate.ok !== "boolean") return null;
  if (!candidate.ok && typeof candidate.error !== "string") return null;
  return candidate as unknown as WebBrowserResponse;
}

export function parseWebBrowserEvent(data: unknown): WebBrowserEvent | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== WEBAPP_BROWSER_EVENT_TYPE || !candidate.event || typeof candidate.event !== "object") return null;
  const browserEvent = candidate.event as Record<string, unknown>;
  if (typeof browserEvent.type !== "string" || !browserEvent.type.startsWith("browser:")) return null;
  return candidate as unknown as WebBrowserEvent;
}

export function parseWebBrowserBinaryFrame(data: unknown): WebBrowserBinaryFrame | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== WEBAPP_BROWSER_BINARY_FRAME_TYPE) return null;
  if (!Number.isSafeInteger(candidate.channelId) || Number(candidate.channelId) < 1) return null;
  if (!Number.isSafeInteger(candidate.sequence) || Number(candidate.sequence) < 0) return null;
  if (!(candidate.data instanceof ArrayBuffer)) return null;
  return candidate as unknown as WebBrowserBinaryFrame;
}

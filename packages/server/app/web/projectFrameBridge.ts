import {
  WEBAPP_PROJECT_RESPONSE_TYPE,
  readWebProjectRequest,
  type WebShellMethod,
} from "../../../core/src/domain/web-console/WebProjectBridge";

/** Correlate project requests and responses with the originating trusted app frame. */
export async function forwardWebProjectRequest(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  origin: string,
  frames: Array<Window | null>,
  rpc: (method: WebShellMethod, payload: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  const source = frames.find((frame) => frame && frame === event.source);
  if (!source) return false;
  const request = readWebProjectRequest(event, origin, source);
  if (!request) return false;
  try {
    const result = await rpc(request.method, request.payload);
    source.postMessage({ type: WEBAPP_PROJECT_RESPONSE_TYPE, id: request.id, ok: true, result }, origin);
  } catch (error) {
    const failure = error as Error & { code?: string };
    source.postMessage({ type: WEBAPP_PROJECT_RESPONSE_TYPE, id: request.id, ok: false,
      error: failure.message || "项目操作失败", code: failure.code }, origin);
  }
  return true;
}

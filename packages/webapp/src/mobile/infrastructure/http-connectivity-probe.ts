import type { ConnectivityProbePort, ProbeResult } from "../domain/ports";
import type { ServerEndpoint } from "../domain/server-endpoint";

const DEFAULT_TIMEOUT_MS = 6_000;

/** fetch 适配器：探测 {base}/api/agent/model，同时把服务端模型带回来供 UI 展示。 */
export class HttpConnectivityProbe implements ConnectivityProbePort {
  constructor(private readonly transport: typeof fetch = (...args) => fetch(...args)) {}

  async probe(endpoint: ServerEndpoint, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.transport(endpoint.api("/api/agent/model"), {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
      const body = (await response.json()) as { modelId?: string };
      return { ok: true, modelId: body.modelId ?? null };
    } catch (error) {
      return { ok: false, reason: error instanceof DOMException && error.name === "AbortError" ? "连接超时" : describe(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || "网络错误";
}

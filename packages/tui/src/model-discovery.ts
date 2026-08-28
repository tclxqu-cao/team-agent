export interface NormalizedModelEndpoint {
  baseUrl: string;
  modelsUrl: string;
  name: string;
}

export interface FetchAvailableModelsInput {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function normalizeModelEndpoint(input: string): NormalizedModelEndpoint {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("模型服务地址无效，请输入完整的 http:// 或 https:// 地址");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("模型服务地址只支持 http:// 或 https://");
  }
  if (url.username || url.password) throw new Error("模型服务地址不能包含用户名或密码");
  url.search = "";
  url.hash = "";

  let pathname = url.pathname.replace(/\/+$/, "");
  let modelsPath: string;
  if (/\/models$/i.test(pathname)) {
    modelsPath = pathname;
    pathname = pathname.replace(/\/models$/i, "");
  } else if (/\/v1$/i.test(pathname)) {
    modelsPath = `${pathname}/models`;
  } else {
    modelsPath = `${pathname}/v1/models`.replace(/\/+/g, "/");
  }

  const providerPath = pathname.replace(/\/v1$/i, "");
  const baseUrl = `${url.origin}${providerPath}`.replace(/\/$/, "");
  const modelsUrl = `${url.origin}${modelsPath}`;
  return { baseUrl, modelsUrl, name: url.host };
}

export async function fetchAvailableModels(input: FetchAvailableModelsInput): Promise<{
  endpoint: NormalizedModelEndpoint;
  models: string[];
}> {
  const endpoint = normalizeModelEndpoint(input.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
    const response = await (input.fetch ?? globalThis.fetch)(endpoint.modelsUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("模型列表响应不是有效 JSON");
    }
    const data = payload && typeof payload === "object" && "data" in payload
      ? (payload as { data?: unknown }).data
      : undefined;
    if (!Array.isArray(data)) throw new Error("模型列表响应缺少 data 数组");
    const models = [...new Set(data.flatMap((item) => {
      if (!item || typeof item !== "object" || !("id" in item)) return [];
      const id = String((item as { id: unknown }).id).trim();
      return id ? [id] : [];
    }))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    if (models.length === 0) throw new Error("模型服务没有返回可用模型");
    return { endpoint, models };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("模型列表请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

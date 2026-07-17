export interface ChatCompletionRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
}

export function buildOpenAICompatibleUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  const versionedBase = normalizedBase.endsWith("/v1") ? normalizedBase : `${normalizedBase}/v1`;
  const normalizedEndpoint = endpoint.trim().startsWith("/") ? endpoint.trim() : `/${endpoint.trim()}`;
  return `${versionedBase}${normalizedEndpoint}`;
}

function parseEventStream(raw: string): Record<string, unknown> {
  let content = "";

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    const event = JSON.parse(data);
    if (event.error) {
      throw new Error(event.error.message ?? JSON.stringify(event.error));
    }
    content += event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.message?.content ?? "";
  }

  return { choices: [{ message: { content } }] };
}

export async function requestChatCompletionContent(request: ChatCompletionRequest): Promise<string> {
  const response = await fetch(buildOpenAICompatibleUrl(request.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
      stream: false,
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`LLM API error: ${response.status} ${raw}`);
  }

  let result: Record<string, any>;
  try {
    const isEventStream = response.headers.get("content-type")?.includes("text/event-stream")
      || raw.trimStart().startsWith("data:");
    result = isEventStream ? parseEventStream(raw) : JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse LLM API response: ${message}`);
  }

  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM API returned no message content");
  }
  return content;
}

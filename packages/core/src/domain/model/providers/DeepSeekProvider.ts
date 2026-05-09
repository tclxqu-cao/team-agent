import type { IModelProvider, Message, StreamEvent, StreamOptions, ModelProviderConfig } from '../entities.js';

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export class DeepSeekProvider implements IModelProvider {
  readonly providerId = "deepseek";
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number;

  constructor(config: ModelProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.modelId = config.modelId;
    this.defaultMaxTokens = config.maxTokens ?? 4096;
    this.defaultTemperature = config.temperature ?? 0.7;
  }

  async *streamChat(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    const adaptedMessages = messages.map((m) => this.adaptMessage(m));

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: adaptedMessages,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      temperature: options?.temperature ?? this.defaultTemperature,
      stream: true,
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      yield { type: "error", message: `DeepSeek API error ${response.status}: ${errText}` };
      return;
    }

    if (!response.body) {
      yield { type: "error", message: "No response body" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          if (!data) continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;

            if (!delta) continue;

            if (delta.content) {
              yield { type: "text_chunk", text: delta.content };
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index as number;
                if (!toolCalls.has(idx)) {
                  toolCalls.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" });
                }
                const entry = toolCalls.get(idx)!;
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name = tc.function.name;
                if (tc.function?.arguments) entry.arguments += tc.function.arguments;
              }
            }

            if (parsed.choices?.[0]?.finish_reason === "tool_calls") {
              for (const [, tc] of toolCalls) {
                try {
                  yield {
                    type: "tool_call",
                    toolCall: {
                      id: tc.id,
                      name: tc.name,
                      arguments: JSON.parse(tc.arguments),
                    },
                  };
                } catch {
                  yield { type: "error", message: `Failed to parse tool arguments for ${tc.name}` };
                }
              }
              toolCalls.clear();
            }
          } catch {
            // skip
          }
        }
      }
      yield { type: "text_done" };
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        yield { type: "error", message: err.message };
      }
    } finally {
      reader.releaseLock();
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  }

  supportsModel(_modelId: string): boolean {
    return true; // OpenAI-compatible; accept any model ID
  }

  private adaptMessage(m: Message): Record<string, unknown> {
    const adapted: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.toolCalls) {
      adapted.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }
    if (m.toolCallId) {
      adapted.role = "tool";
      adapted.tool_call_id = m.toolCallId;
    }
    return adapted;
  }
}

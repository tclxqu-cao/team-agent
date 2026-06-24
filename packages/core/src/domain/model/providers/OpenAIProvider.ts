import type { IModelProvider, Message, StreamEvent, StreamOptions, ModelProviderConfig } from '../entities.js';

const DEFAULT_BASE_URL = "https://api.openai.com";

export class OpenAIProvider implements IModelProvider {
  readonly providerId = "openai";
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number;

  constructor(config: ModelProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.modelId = config.modelId;
    this.defaultMaxTokens = config.maxTokens ?? 16384;
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
      yield { type: "error", message: `OpenAI API error ${response.status}: ${errText}` };
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

    // Chunk-level timeout: if no data arrives for 60s, abort the stream
    const CHUNK_TIMEOUT_MS = 60_000;
    const readWithTimeout = () => {
      let timer: ReturnType<typeof setTimeout>;
      return Promise.race([
        reader.read().finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Stream chunk timeout: no data received for 60s")), CHUNK_TIMEOUT_MS);
        }),
      ]);
    };

    try {
      while (true) {
        const { done, value } = await readWithTimeout();
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

            const finishReason = parsed.choices?.[0]?.finish_reason;
            if (finishReason === "length" && toolCalls.size > 0) {
              const names = [...toolCalls.values()].map((tc) => tc.name).join(", ");
              yield { type: "error", message: `输出被截断（max_tokens 限制），工具 ${names} 的参数 JSON 不完整。请拆分成更小的步骤，或在设置中提高模型输出 token 上限。` };
              toolCalls.clear();
            } else if (finishReason === "tool_calls" || (finishReason && toolCalls.size > 0)) {
              for (const [, tc] of toolCalls) {
                try {
                  yield {
                    type: "tool_call",
                    toolCall: {
                      id: tc.id,
                      name: tc.name,
                      arguments: JSON.parse(tc.arguments.trim()),
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
      // Flush any tool calls that weren't emitted (stream ended without finish_reason)
      for (const [, tc] of toolCalls) {
        try {
          yield {
            type: "tool_call",
            toolCall: { id: tc.id, name: tc.name, arguments: JSON.parse(tc.arguments.trim()) },
          };
        } catch {
          yield { type: "error", message: `Failed to parse tool arguments for ${tc.name}` };
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

  supportsModel(modelId: string): boolean {
    return modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4");
  }

  private adaptMessage(m: Message): Record<string, unknown> {
    const adapted: Record<string, unknown> = {
      role: m.role,
      // OpenAI-compatible APIs require content to be null (not "") when tool_calls is
      // present on an assistant message — sending "" causes some providers to reject
      // the message or fail to link tool results, causing the agent to loop.
      content: (m.toolCalls && m.toolCalls.length > 0) ? null : (m.content || null),
    };
    // Vision: build multimodal content blocks when images are present
    if (m.images && m.images.length > 0 && !m.toolCalls && !m.toolCallId) {
      adapted.content = [
        { type: "text", text: m.content || "" },
        ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
      ];
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      adapted.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
      adapted.role = "assistant";
    }
    if (m.toolCallId) {
      adapted.role = "tool";
      adapted.tool_call_id = m.toolCallId;
    }
    if (m.role === "system" && adapted.role === "system") {
      // OpenAI expects system role key
      adapted.role = "system";
    }
    return adapted;
  }
}

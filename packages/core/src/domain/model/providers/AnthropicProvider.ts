import type { IModelProvider, Message, StreamEvent, StreamOptions, ModelProviderConfig } from '../entities.js';

const DEFAULT_BASE_URL = "https://api.anthropic.com";

export class AnthropicProvider implements IModelProvider {
  readonly providerId = "anthropic";
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
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");
    const systemPrompt = systemMessages.map((m) => m.content).join("\n\n");

    const body: Record<string, unknown> = {
      model: this.modelId,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      temperature: options?.temperature ?? this.defaultTemperature,
      messages: nonSystem.map((m) => this.adaptMessage(m)),
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: "object",
          properties: t.parameters,
          required: Object.keys(t.parameters),
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      yield { type: "error", message: `Anthropic API error ${response.status}: ${errText}` };
      return;
    }

    if (!response.body) {
      yield { type: "error", message: "No response body" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentToolCall: { id: string; name: string; arguments: string } | null = null;

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

            if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
              currentToolCall = {
                id: parsed.content_block.id,
                name: parsed.content_block.name,
                arguments: "",
              };
            } else if (parsed.type === "content_block_delta") {
              if (parsed.delta?.type === "text_delta") {
                yield { type: "text_chunk", text: parsed.delta.text };
              } else if (parsed.delta?.type === "input_json_delta" && currentToolCall) {
                currentToolCall.arguments += parsed.delta.partial_json;
              }
            } else if (parsed.type === "content_block_stop" && currentToolCall) {
              try {
                const parsedArgs = JSON.parse(currentToolCall.arguments);
                yield {
                  type: "tool_call",
                  toolCall: {
                    id: currentToolCall.id,
                    name: currentToolCall.name,
                    arguments: parsedArgs,
                  },
                };
              } catch {
                yield { type: "error", message: "Failed to parse tool arguments" };
              }
              currentToolCall = null;
            } else if (parsed.type === "error") {
              yield { type: "error", message: parsed.error?.message ?? "Stream error" };
              return;
            }
          } catch {
            // skip unparseable lines
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
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");

    const response = await fetch(`${this.baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.modelId,
        messages: nonSystem.map((m) => this.adaptMessage(m)),
        ...(systemMessages.length > 0
          ? { system: systemMessages.map((m) => m.content).join("\n\n") }
          : {}),
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return this.estimateTokens(messages);
    }

    const data = await response.json() as { input_tokens?: number };
    return data.input_tokens ?? this.estimateTokens(messages);
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith("claude-");
  }

  private adaptMessage(m: Message): Record<string, unknown> {
    const adapted: Record<string, unknown> = {
      role: m.role === "tool" ? "user" : m.role,
      content: m.content,
    };
    // Vision: build multimodal content blocks when images are present
    if (m.images && m.images.length > 0 && !m.toolCalls && !m.toolCallId) {
      const imageBlocks = m.images.flatMap((dataUrl) => {
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return [];
        return [{ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }];
      });
      adapted.content = [...imageBlocks, { type: "text", text: m.content || "" }];
      return adapted;
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      adapted.content = m.toolCalls.map((tc) => ({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      }));
      adapted.role = "assistant";
    }
    if (m.toolCallId) {
      adapted.content = [
        { type: "tool_result", tool_use_id: m.toolCallId, content: m.content },
      ];
    }
    return adapted;
  }

  private estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  }
}

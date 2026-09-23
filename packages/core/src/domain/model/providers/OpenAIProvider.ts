import type { IModelProvider, Message, StreamEvent, StreamOptions, ModelProviderConfig } from '../entities.js';
import type { ToolDefinition } from '../entities.js';
import { openAIEndpoint } from './openAIEndpoint.js';
import { estimateRequestTokens } from '../tokenBudget.js';
import { isModelRequestTimeout, modelRequestTimeoutEvent } from './requestTimeout.js';

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_TIMEOUT_MS = 300_000;

export class OpenAIProvider implements IModelProvider {
  readonly providerId = "openai";
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number;
  private readonly timeoutMs: number;
  private localContext?: Promise<number | undefined>;

  constructor(config: ModelProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = openAIEndpoint(config.baseUrl || DEFAULT_BASE_URL);
    this.modelId = config.modelId;
    this.defaultMaxTokens = config.maxTokens ?? 16384;
    this.defaultTemperature = config.temperature ?? 0.7;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async *streamChat(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    const adaptedMessages = messages.map((m) => this.adaptMessage(m));
    const localContext = await this.getContextWindow();

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: adaptedMessages,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      temperature: options?.temperature ?? this.defaultTemperature,
      stream: true,
    };

    if (options?.reasoningEffort && options.reasoningEffort !== "off") {
      body.reasoning_effort = options.reasoningEffort;
    }
    if (localContext && options?.reasoningEffort === "off") {
      body.chat_template_kwargs = { enable_thinking: false };
    }

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

    const requestSignal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      if (isModelRequestTimeout(error, requestSignal)) {
        yield modelRequestTimeoutEvent("OpenAI", this.timeoutMs);
        return;
      }
      throw error;
    }

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
    let reasoningBuffer = "";
    let reasoningLastFlushedAt = Date.now();
    let terminatedWithError = false;
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    const parseBufferedToolCalls = (incomplete: boolean): { events?: StreamEvent[]; error?: StreamEvent } => {
      const events: StreamEvent[] = [];
      for (const [, tc] of toolCalls) {
        try {
          events.push({
            type: "tool_call",
            toolCall: {
              id: tc.id,
              name: tc.name,
              arguments: JSON.parse(tc.arguments.trim()),
            },
          });
        } catch {
          return {
            error: incomplete
              ? {
                  type: "error",
                  code: "tool_arguments_incomplete",
                  message: `模型输出在工具 ${tc.name} 的参数生成完成前中断，参数 JSON 不完整，已拒绝执行。请重试，或提高该模型配置的单轮最大输出。`,
                }
              : {
                  type: "error",
                  code: "tool_arguments_invalid",
                  message: `工具 ${tc.name} 的参数不是有效 JSON，已拒绝执行。请让模型重新生成工具调用。`,
                },
          };
        }
      }
      return { events };
    };
    const takeReasoningBuffer = (): StreamEvent | undefined => {
      if (!reasoningBuffer) return undefined;
      const event: StreamEvent = { type: "reasoning_delta", text: reasoningBuffer };
      reasoningBuffer = "";
      reasoningLastFlushedAt = Date.now();
      return event;
    };

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
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;

            if (!choice || terminatedWithError) continue;

            if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
              reasoningBuffer += delta.reasoning_content;
              if (reasoningBuffer.length >= 256 || Date.now() - reasoningLastFlushedAt >= 150) {
                const reasoningEvent = takeReasoningBuffer();
                if (reasoningEvent) yield reasoningEvent;
              }
            }

            if (typeof delta?.content === "string" && delta.content) {
              const reasoningEvent = takeReasoningBuffer();
              if (reasoningEvent) yield reasoningEvent;
              yield { type: "text_chunk", text: delta.content };
            }

            if (delta?.tool_calls) {
              const reasoningEvent = takeReasoningBuffer();
              if (reasoningEvent) yield reasoningEvent;
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

            const finishReason = choice.finish_reason;
            if (finishReason) {
              const reasoningEvent = takeReasoningBuffer();
              if (reasoningEvent) yield reasoningEvent;
            }
            if (finishReason === "length") {
              const message = toolCalls.size > 0
                ? `输出被截断（max_tokens 限制），工具 ${[...toolCalls.values()].map((tc) => tc.name).join(", ")} 的参数 JSON 不完整。请拆分成更小的步骤，或在设置中提高模型输出 token 上限。`
                : "输出被截断（max_tokens 限制），模型在生成完整回答前已用完输出 token。请缩小任务范围，或在设置中提高模型输出 token 上限。";
              yield { type: "error", message };
              toolCalls.clear();
              terminatedWithError = true;
            } else if (finishReason === "tool_calls" || (finishReason && toolCalls.size > 0)) {
              const parsedToolCalls = parseBufferedToolCalls(false);
              if (parsedToolCalls.error) {
                yield parsedToolCalls.error;
                terminatedWithError = true;
              } else {
                for (const event of parsedToolCalls.events ?? []) yield event;
              }
              toolCalls.clear();
            }
          } catch {
            // skip
          }
        }
      }
      if (!terminatedWithError) {
        const reasoningEvent = takeReasoningBuffer();
        if (reasoningEvent) yield reasoningEvent;
        // Flush any tool calls that weren't emitted (stream ended without finish_reason)
        const parsedToolCalls = parseBufferedToolCalls(true);
        if (parsedToolCalls.error) {
          yield parsedToolCalls.error;
          return;
        }
        for (const event of parsedToolCalls.events ?? []) yield event;
        yield { type: "text_done" };
      }
    } catch (err) {
      if (isModelRequestTimeout(err, requestSignal)) {
        const reasoningEvent = takeReasoningBuffer();
        if (reasoningEvent) yield reasoningEvent;
        yield modelRequestTimeoutEvent("OpenAI", this.timeoutMs);
      } else if (err instanceof Error && err.name !== "AbortError") {
        const reasoningEvent = takeReasoningBuffer();
        if (reasoningEvent) yield reasoningEvent;
        yield { type: "error", message: err.message };
      }
    } finally {
      reader.releaseLock();
    }
  }

  async countTokens(messages: Message[]): Promise<number> {
    return this.countRequestTokens(messages);
  }

  getContextWindow(): Promise<number | undefined> {
    return this.localContext ??= this.discoverLocalContext();
  }

  private async discoverLocalContext(): Promise<number | undefined> {
    const endpoint = new URL(this.baseUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) return undefined;
    try {
      const url = new URL(endpoint);
      url.pathname = url.pathname.replace(/\/chat\/completions$/, "/models");
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return undefined;
      const data = await response.json() as { data?: Array<{ id: string; owned_by?: string; meta?: { n_ctx?: number } }> };
      const model = data.data?.find((m) => m.id === this.modelId || `local/${m.id}` === this.modelId)
        ?? (data.data?.length === 1 ? data.data[0] : undefined);
      const size = model?.meta?.n_ctx;
      return model?.owned_by === "llamacpp" && Number.isFinite(size) && size! > 0 ? size : undefined;
    } catch { return undefined; }
  }

  async countRequestTokens(messages: Message[], tools: ToolDefinition[] = []): Promise<number> {
    if (await this.getContextWindow() && !messages.some((m) => m.images?.length)) {
      try {
        const endpoint = new URL(this.baseUrl);
        const prefix = endpoint.pathname.replace(/\/v1\/chat\/completions$/, "");
        const post = async (path: string, body: unknown) => {
          const url = new URL(endpoint);
          url.pathname = `${prefix}/${path}`;
          const response = await fetch(url, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error(`Token count failed: ${response.status}`);
          return response.json();
        };
        // Count with the default thinking template: conservative when thinking is off.
        const rendered = await post("apply-template", {
          messages: (messages.length ? messages : [{ role: "user" as const, content: " " }]).map((m) => this.adaptMessage(m)), add_generation_prompt: true,
          ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })) } : {}),
        }) as { prompt?: string };
        if (typeof rendered.prompt !== "string") throw new Error("Missing template");
        const tokenized = await post("tokenize", { content: rendered.prompt, add_special: true, parse_special: true }) as { tokens?: unknown[] };
        if (Array.isArray(tokenized.tokens)) return tokenized.tokens.length;
      } catch { /* Compatible servers may not expose the tokenizer. */ }
    }
    return estimateRequestTokens(messages, tools);
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4");
  }

  private stringContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (content === null || content === undefined) return "";
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  private adaptMessage(m: Message): Record<string, unknown> {
    const content = this.stringContent(m.content);
    const hasToolCalls = !!(m.toolCalls && m.toolCalls.length > 0);
    // OpenAI-compatible APIs:
    //  - assistant + tool_calls: content must be null (not "")
    //  - tool role: content must be a non-null string
    //  - user/system: content must be string or list, never null
    // So only assistant+tool_calls gets null; everyone else gets a string (empty -> " ").
    const contentForRequest = hasToolCalls ? null : (content.length > 0 ? content : " ");
    const adapted: Record<string, unknown> = {
      role: m.role,
      content: contentForRequest,
    };
    // Vision: build multimodal content blocks when images are present
    if (m.images && m.images.length > 0 && !m.toolCalls && !m.toolCallId) {
      adapted.content = [
        { type: "text", text: content },
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

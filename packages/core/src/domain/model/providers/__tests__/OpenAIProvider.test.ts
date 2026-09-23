import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../OpenAIProvider.js';
import { DeepSeekProvider } from '../DeepSeekProvider.js';
import { estimateRequestTokens } from '../../tokenBudget.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const done = () => new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
const streamResponse = (...payloads: unknown[]) => new Response([
  ...payloads.map((payload) => `data: ${JSON.stringify(payload)}`),
  'data: [DONE]',
  '',
].join('\n\n'));

describe('OpenAI compatible endpoints', () => {
  for (const Provider of [OpenAIProvider, DeepSeekProvider]) {
    it.each(['https://example.com', 'https://example.com/v1/', ' https://example.com/v1/chat/completions/ '])(
      `${Provider.name} accepts %s`, async (baseUrl) => {
        const fetchMock = vi.fn().mockImplementation(done);
        vi.stubGlobal('fetch', fetchMock);
        const provider = new Provider({ baseUrl, apiKey: 'test', modelId: 'local-model' });
        const events = [];
        for await (const event of provider.streamChat([{ role: 'user', content: 'Hi' }])) events.push(event);
        expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/v1/chat/completions');
        expect(events).toContainEqual({ type: 'text_chunk', text: 'OK' });
      },
    );
  }

  it.each([
    [OpenAIProvider, 'OpenAI'],
    [DeepSeekProvider, 'DeepSeek'],
  ])('%s applies the configured whole-request timeout', async (Provider) => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(done));
    const provider = new Provider({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test',
      modelId: 'model',
      timeoutMs: 456_000,
    });

    for await (const _ of provider.streamChat([{ role: 'user', content: 'Hi' }])) { /* consume */ }

    expect(timeoutSpy).toHaveBeenCalledWith(456_000);
  });

  it.each([
    [OpenAIProvider, 'OpenAI'],
    [DeepSeekProvider, 'DeepSeek'],
  ])('%s returns a stable error when the initial request times out', async (Provider, label) => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    const provider = new Provider({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test',
      modelId: 'model',
      timeoutMs: 600_000,
    });
    const events = [];

    for await (const event of provider.streamChat([{ role: 'user', content: 'Hi' }])) events.push(event);

    expect(events).toEqual([{
      type: 'error',
      code: 'model_request_timeout',
      message: expect.stringContaining(`${label} 单次请求超过 600 秒`),
    }]);
    expect(events.some((event) => event.type === 'text_done')).toBe(false);
  });

  it('uses llama.cpp runtime size and counts the templated native tools', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/v1/models') return Response.json({ data: [{ id: '/model.gguf', owned_by: 'llamacpp', meta: { n_ctx: 8192, n_ctx_train: 262144 } }] });
      if (path === '/apply-template') return Response.json({ prompt: 'rendered native tool prompt' });
      if (path === '/tokenize') return Response.json({ tokens: [1, 2, 3, 4, 5] });
      return done();
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:8080/v1', apiKey: '', modelId: 'local//model.gguf' });
    expect(await provider.getContextWindow()).toBe(8192);
    const tools = [{ name: 'echo', description: '中文工具', parameters: { type: 'object' } }];
    expect(await provider.countRequestTokens([{ role: 'user', content: '你好' }], tools)).toBe(5);
    const templateBody = JSON.parse(fetchMock.mock.calls.find(([url]) => new URL(url).pathname === '/apply-template')![1]!.body as string);
    expect(templateBody.tools[0]).toEqual({ type: 'function', function: tools[0] });
    for await (const _ of provider.streamChat([{ role: 'user', content: '你好' }], { reasoningEffort: 'off', maxTokens: 1024 })) { /* consume */ }
    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string);
    expect(body.max_tokens).toBe(1024);
    expect(body.chat_template_kwargs.enable_thinking).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => new URL(url).pathname === '/v1/models')).toHaveLength(1);
  });

  it('falls back when a compatible server has no llama metadata and counts Chinese and schemas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'model' }] })));
    const provider = new OpenAIProvider({ baseUrl: 'http://localhost:8080', apiKey: '', modelId: 'model' });
    expect(await provider.getContextWindow()).toBeUndefined();
    const messages = [{ role: 'user' as const, content: '中文'.repeat(500) }];
    const tools = [{ name: 'echo', description: '工具'.repeat(100), parameters: {} }];
    expect(await provider.countRequestTokens(messages, tools)).toBeGreaterThan(1200);
    expect(await provider.countRequestTokens(messages, tools)).toBe(estimateRequestTokens(messages, tools));
  });

  it('sends an image observation after tool messages to OpenAI', async () => {
    const fetchMock = vi.fn().mockImplementation(done);
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider({ baseUrl: 'https://example.com/v1', apiKey: 'test', modelId: 'gpt-4o' });
    for await (const _ of provider.streamChat([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'computer', arguments: { action: 'screenshot' } }] },
      { role: 'tool', content: '{"source":"screenshot"}', toolCallId: 'call-1', name: 'computer' },
      { role: 'user', content: 'Visual observations from tool calls: call-1', images: ['data:image/jpeg;base64,YWJj'] },
    ])) { /* consume */ }
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(['assistant', 'tool', 'user']);
    expect(body.messages[2].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YWJj' } });
  });

  it('streams compatible reasoning separately before answer text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(
      { choices: [{ delta: { reasoning_content: '先分析，' }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: '再回答。' }, finish_reason: null }] },
      { choices: [{ delta: { content: '最终答案' }, finish_reason: 'stop' }] },
    )));
    const provider = new OpenAIProvider({ baseUrl: 'https://example.com/v1', apiKey: 'test', modelId: 'step-5-preview' });
    const events = [];

    for await (const event of provider.streamChat([{ role: 'user', content: 'Hi' }])) events.push(event);

    expect(events).toEqual([
      { type: 'reasoning_delta', text: '先分析，再回答。' },
      { type: 'text_chunk', text: '最终答案' },
      { type: 'text_done' },
    ]);
  });

  it('flushes a full reasoning batch before stream completion', async () => {
    const reasoning = 'x'.repeat(256);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(
      { choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    )));
    const provider = new OpenAIProvider({ baseUrl: 'https://example.com/v1', apiKey: 'test', modelId: 'step-5-preview' });
    const events = [];

    for await (const event of provider.streamChat([{ role: 'user', content: 'Hi' }])) events.push(event);

    expect(events).toEqual([
      { type: 'reasoning_delta', text: reasoning },
      { type: 'text_done' },
    ]);
  });

  it('flushes reasoning at normal completion even without answer text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(
      { choices: [{ delta: { reasoning_content: '仍在思考' }, finish_reason: 'stop' }] },
    )));
    const provider = new OpenAIProvider({ baseUrl: 'https://example.com/v1', apiKey: 'test', modelId: 'step-5-preview' });
    const events = [];

    for await (const event of provider.streamChat([{ role: 'user', content: 'Hi' }])) events.push(event);

    expect(events).toEqual([
      { type: 'reasoning_delta', text: '仍在思考' },
      { type: 'text_done' },
    ]);
  });

  it('reports reasoning-only token truncation without completing the text stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(
      { choices: [{ delta: { reasoning_content: '推理尚未结束' }, finish_reason: 'length' }] },
    )));
    const provider = new OpenAIProvider({ baseUrl: 'https://example.com/v1', apiKey: 'test', modelId: 'step-5-preview' });
    const events = [];

    for await (const event of provider.streamChat([{ role: 'user', content: 'Hi' }])) events.push(event);

    expect(events).toEqual([
      { type: 'reasoning_delta', text: '推理尚未结束' },
      expect.objectContaining({ type: 'error', message: expect.stringContaining('输出被截断') }),
    ]);
    expect(events.some((event) => event.type === 'text_done')).toBe(false);
  });

  it('does not emit an incomplete tool call when output is truncated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'write_file', arguments: '{"path":' } }] }, finish_reason: 'length' }] },
    )));
    const provider = new OpenAIProvider({ baseUrl: 'https://example.com/v1', apiKey: 'test', modelId: 'step-5-preview' });
    const events = [];

    for await (const event of provider.streamChat([{ role: 'user', content: 'Hi' }])) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining('工具 write_file') }),
    ]);
    expect(events.some((event) => event.type === 'tool_call' || event.type === 'text_done')).toBe(false);
  });

  it('rejects incomplete tool arguments when the stream ends without a finish reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'write_file', arguments: '{"path":"/tmp/a","content":"<svg>' } }] }, finish_reason: null }] },
    )));
    const provider = new OpenAIProvider({ baseUrl: 'https://example.com/v1', apiKey: 'test', modelId: 'step-5-preview' });
    const events = [];

    for await (const event of provider.streamChat([{ role: 'user', content: 'Hi' }])) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'tool_arguments_incomplete',
        message: expect.stringContaining('工具 write_file'),
      }),
    ]);
    expect(events.some((event) => event.type === 'tool_call' || event.type === 'text_done')).toBe(false);
  });

  it('rejects an entire completed tool batch when any argument payload is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' } },
        { index: 1, id: 'call-2', function: { name: 'write_file', arguments: '{"path":' } },
      ] }, finish_reason: 'tool_calls' }] },
    )));
    const provider = new OpenAIProvider({ baseUrl: 'https://example.com/v1', apiKey: 'test', modelId: 'step-5-preview' });
    const events = [];

    for await (const event of provider.streamChat([{ role: 'user', content: 'Hi' }])) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'tool_arguments_invalid' }),
    ]);
    expect(events.some((event) => event.type === 'tool_call' || event.type === 'text_done')).toBe(false);
  });

  it('rejects image observations before DeepSeek network dispatch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new DeepSeekProvider({ baseUrl: 'https://example.com/v1', apiKey: 'test', modelId: 'deepseek-chat' });
    const events = [];
    for await (const event of provider.streamChat([
      { role: 'user', content: 'visual', images: ['data:image/jpeg;base64,YWJj'] },
    ])) events.push(event);
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'vision_unavailable' })]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

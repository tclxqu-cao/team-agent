import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../OpenAIProvider.js';
import { DeepSeekProvider } from '../DeepSeekProvider.js';
import { estimateRequestTokens } from '../../tokenBudget.js';

afterEach(() => vi.unstubAllGlobals());
const done = () => new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');

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
});

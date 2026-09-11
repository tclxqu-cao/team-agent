import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessServiceClient } from './HarnessServiceClient.js';

async function until(check: () => boolean, timeout = 6000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error('Companion state timed out'); await new Promise(resolve => setTimeout(resolve, 30)); }
}
describe('Harness source companion lifecycle', () => {
  it.skipIf(process.platform !== 'darwin')('starts once without host model configuration and exits with the host', async () => {
    const state = await mkdtemp(join(tmpdir(), 'harness-client-'));
    const client = new HarnessServiceClient({ owner: 'tui', sourceRoot: process.cwd(), stateDirectory: state, enabled: true });
    let pid = 0;
    try {
      await Promise.all([client.start(), client.start()]);
      await until(() => client.status.state === 'ready');
      pid = client.status.pid!;
      client.setModel({ provider: 'openai', apiKey: 'do-not-persist', modelId: 'first' });
      await until(() => client.status.state === 'ready');
      client.setModel({ provider: 'openai', apiKey: 'do-not-persist', modelId: 'second' });
      expect(client.status.modelId).toBeUndefined();
      expect(client.status.pid).toBe(pid);
      const events = async function* () {
        client.observe('quality-session', { type: 'request_context', iteration: 1, providerId: 'test', modelId: 'fake',
          messages: [{ role: 'user', preview: 'api_key=secret-value' }] });
        yield { type: 'tool_call' as const, toolCall: { id: 'call', name: 'read', arguments: { path: '/tmp/test' } } };
        yield { type: 'tool_result' as const, result: { toolCallId: 'call', content: 'example' } };
        yield { type: 'done' as const, finalText: 'done' };
      };
      for await (const _event of client.monitor(events(), { input: 'observe only', sessionId: 'quality-session', workingDirectory: '/tmp' })) { /* no model call */ }
      await until(() => (client.status.quality as { sessions?: number } | undefined)?.sessions === 1);
      const project = (await readdir(join(state, 'quality')))[0];
      const records = await readdir(join(state, 'quality', project, 'runs'));
      const record = JSON.parse(await readFile(join(state, 'quality', project, 'runs', records[0]), 'utf8'));
      expect(record.model).toBe('test/fake');
      expect(record.runtimeVersion).not.toBe('unknown');
      expect(record.observations.some((event: { type: string }) => event.type === 'request_context')).toBe(true);
      expect(JSON.stringify(record)).not.toContain('secret-value');

      const text = await readFile(join(state, 'services', `tui-${process.pid}.json`), 'utf8');
      expect(text).not.toContain('do-not-persist');
      expect(text).not.toContain('apiKey');
    } finally {
      client.close();
      if (pid) await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
      await rm(state, { recursive: true, force: true });
    }
  }, 10_000);
  it('disabled mode preserves the original Agent events and errors without launching', async () => {
    const client = new HarnessServiceClient({ owner: 'tui', enabled: false });
    const error = new Error('original');
    const events = async function* () { yield { type: 'text_chunk' as const, text: 'hello' }; throw error; };
    const seen: Array<{ type: 'text_chunk'; text: string }> = [];
    await expect((async () => {
      for await (const event of client.monitor(events(), { input: 'test', sessionId: 's', workingDirectory: '/tmp' })) seen.push(event as { type: 'text_chunk'; text: string });
    })()).rejects.toBe(error);
    expect(seen).toEqual([{ type: 'text_chunk', text: 'hello' }]);
    expect(client.status.pid).toBeUndefined(); client.close();
  });
});

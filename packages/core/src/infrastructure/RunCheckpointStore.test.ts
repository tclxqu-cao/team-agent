import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { FileRunCheckpointStore } from './RunCheckpointStore.js';
import { AgentBuilder } from '../domain/agent/AgentBuilder.js';
import type { IModelProvider } from '../domain/model/entities.js';
import type { RunCheckpoint } from '../domain/agent/run-checkpoint.js';

const dirs: string[] = [];
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'harness-checkpoint-')); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const base = (dir: string): RunCheckpoint => ({ schema: 1, input: 'task', sessionId: 's', workingDirectory: dir,
  phase: 'ready', iteration: 0, pendingToolIds: [], messages: [{ role: 'user', content: 'task' }] });

describe('durable Harness recovery', () => {
  it('round trips atomically with private permissions and rejects corruption', async () => {
    const dir = await directory();
    const file = join(dir, 'cp.json');
    const store = new FileRunCheckpointStore(file);
    expect(await store.load()).toBeNull();
    await store.save(base(dir));
    expect(await store.load()).toEqual(base(dir));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFile(file, '{broken');
    await expect(store.load()).rejects.toThrow();
    await writeFile(file, JSON.stringify({ ...base(dir), schema: 2 }));
    await expect(store.load()).rejects.toThrow('schema');
  });

  it('a restarted Loop sees completed tool results without executing the tool twice', async () => {
    const dir = await directory();
    const store = new FileRunCheckpointStore(join(dir, 'cp.json'));
    const execute = vi.fn(async () => ({ toolCallId: '', content: 'side effect committed' }));
    const provider: IModelProvider = {
      providerId: 'mock', modelId: 'mock', countTokens: async () => 10, supportsModel: () => true,
      streamChat: async function* (messages) {
        if (messages.some(m => m.role === 'tool')) yield { type: 'text_chunk', text: 'recovered' };
        else yield { type: 'tool_call', toolCall: { id: 'effect-1', name: 'effect', arguments: {} } };
        yield { type: 'text_done' };
      },
    };
    const build = (crash: boolean) => new AgentBuilder().withWorkingDirectory(dir).withModelProvider(provider)
      .withSemanticSkillMatching(false).withEnabledTools(['effect'])
      .withTool({ name: 'effect', description: 'effect', parameters: {}, schema: z.object({}), execute })
      .withRunCheckpointStore({ load: () => store.load(), save: async cp => {
        await store.save(cp);
        if (crash && cp.phase === 'ready' && cp.messages.some(m => m.role === 'tool')) throw new Error('process crash');
      } }).build();
    const first = await build(true);
    await expect((async () => { for await (const _ of first.run('task', 's')) {} })()).rejects.toThrow('process crash');
    expect(execute).toHaveBeenCalledTimes(1);
    const second = await build(false);
    const events = [];
    for await (const event of second.run('task', 's')) events.push(event);
    expect(events.at(-1)).toEqual({ type: 'done', finalText: 'recovered' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await store.load())?.phase).toBe('completed');
    // Terminal recovery does not even initialize a provider context.
    provider.getContextWindow = () => { throw new Error('must not run'); };
    for await (const event of second.run('task', 's')) expect(event).toEqual({ type: 'done', finalText: 'recovered' });
  });

  it('refuses unknown effects and mismatched task identity before model or tool access', async () => {
    const dir = await directory();
    const store = new FileRunCheckpointStore(join(dir, 'cp.json'));
    await store.save({ ...base(dir), phase: 'tools_pending', pendingToolIds: ['effect-1'] });
    const model = { providerId: 'mock', modelId: 'mock', countTokens: async () => 0, supportsModel: () => true,
      streamChat: async function* () { throw new Error('must not invoke model'); } };
    const agent = await new AgentBuilder().withWorkingDirectory(dir).withModelProvider(model).withRunCheckpointStore(store).build();
    const drain = async (input: string) => { for await (const _ of agent.run(input, 's')) {} };
    await expect(drain('task')).rejects.toThrow('pending tool effects');
    await expect(drain('different')).rejects.toThrow('identity mismatch');
  });
});

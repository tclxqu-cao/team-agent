import { describe, it, expect, vi } from 'vitest';
import { HarnessCompanion, type CompanionStatus } from './daemon-service.js';
import type { HarnessConfig } from './supervisor.js';
const config = { idleTimeoutMs: 100 } as HarnessConfig;
const model = { provider: 'openai', modelId: 'first', apiKey: 'private-test-key', baseUrl: 'http://model' };
const task = { type: 'begin', id: 'run', sessionId: 's', input: 'do not replay business action', workingDirectory: '/tmp' };
const result = { status: 'blocked' as const, runDirectory: '/tmp/evidence', attempts: [], detail: 'verified' };

describe('automatic Harness companion', () => {
  it('stays idle and dispatches repair independently of host model settings', async () => {
    const statuses: CompanionStatus[] = [], repair = vi.fn(async () => result);
    const service = new HarnessCompanion(config, status => statuses.push(status), repair);
    expect(statuses.at(-1)?.state).toBe('ready');
    service.receive({ type: 'configure', model });
    service.tick(Date.now() + 1000);
    expect(repair).not.toHaveBeenCalled();
    service.receive({ type: 'configure', model: { ...model, modelId: 'second' } });
    service.receive(task);
    service.receive({ type: 'fault', id: 'run', message: 'Harness exception' });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(statuses)).not.toContain(model.apiKey);
    await service.close();
  });
  it('does not mistake approvals for a stuck Harness and deduplicates repeated faults', async () => {
    const repair = vi.fn(async () => result);
    const service = new HarnessCompanion(config, () => {}, repair);
    service.receive({ type: 'configure', model });
    service.receive(task);
    service.receive({ type: 'waiting', sessionId: 's', waiting: true });
    service.tick(Date.now() + 10000);
    expect(repair).not.toHaveBeenCalled();
    service.receive({ type: 'waiting', sessionId: 's', waiting: false });
    service.tick(Date.now() + 10000);
    service.tick(Date.now() + 20000);
    expect(repair).toHaveBeenCalledTimes(1);
    service.receive({ type: 'fault', id: 'run', message: 'another report' });
    expect(repair).toHaveBeenCalledTimes(1);
    await service.close();
  });
  it.each(['aihub', 'openai', 'deepseek'])(
    'does not report %s while its model request is within the extended idle window',
    async (providerId) => {
      const repair = vi.fn(async () => result);
      const service = new HarnessCompanion(config, () => {}, repair);
      const startedAt = Date.now();
      service.receive(task);
      service.receive({ type: 'observation', sessionId: 's', data: {
        type: 'request_context', iteration: 1, providerId, modelId: 'test-model',
      } });

      service.tick(startedAt + 150);
      expect(repair).not.toHaveBeenCalled();
      await service.close();
    },
  );
  it.each(['aihub', 'openai', 'deepseek'])(
    'still detects %s requests that exceed the extended idle window',
    async (providerId) => {
      const repair = vi.fn(async () => result);
      const service = new HarnessCompanion(config, () => {}, repair);
      const startedAt = Date.now();
      service.receive(task);
      service.receive({ type: 'observation', sessionId: 's', data: {
        type: 'request_context', iteration: 1, providerId, modelId: 'test-model',
      } });

      service.tick(startedAt + 250);
      expect(repair).toHaveBeenCalledTimes(1);
      await service.close();
    },
  );
  it('keeps the original idle deadline for providers whose transport timeout is shorter', async () => {
    const repair = vi.fn(async () => result);
    const service = new HarnessCompanion(config, () => {}, repair);
    const startedAt = Date.now();
    service.receive(task);
    service.receive({ type: 'observation', sessionId: 's', data: {
      type: 'request_context', iteration: 1, providerId: 'anthropic', modelId: 'claude-test',
    } });

    service.tick(startedAt + 150);
    expect(repair).toHaveBeenCalledTimes(1);
    await service.close();
  });
  it('restores the original idle deadline after the model starts responding', async () => {
    const repair = vi.fn(async () => result);
    const service = new HarnessCompanion(config, () => {}, repair);
    const startedAt = Date.now();
    service.receive(task);
    service.receive({ type: 'observation', sessionId: 's', data: {
      type: 'request_context', iteration: 1, providerId: 'aihub', modelId: 'deepseek',
    } });
    service.receive({ type: 'progress', id: 'run', eventType: 'text_chunk', data: { type: 'text_chunk' } });

    service.tick(startedAt + 150);
    expect(repair).toHaveBeenCalledTimes(1);
    await service.close();
  });
  it('removes finished runs and cancels an in-flight repair on shutdown', async () => {
    const repair = vi.fn((_task, _message, signal: AbortSignal) => new Promise<typeof result>(resolve => {
      signal.addEventListener('abort', () => resolve(result), { once: true });
    }));
    const service = new HarnessCompanion(config, () => {}, repair);
    service.receive({ type: 'configure', model }); service.receive(task);
    service.receive({ type: 'end', id: 'run' }); service.tick(Date.now() + 10000);
    expect(repair).not.toHaveBeenCalled();
    service.receive(task); service.receive({ type: 'fault', id: 'run', message: 'crash' });
    await service.close();
    expect(repair.mock.calls[0][2].aborted).toBe(true);
  });
});

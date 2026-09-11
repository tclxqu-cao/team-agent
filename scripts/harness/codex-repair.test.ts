import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairWithCodex } from './codex-repair.js';
import type { HarnessConfig } from './supervisor.js';
import type { CommandOptions } from './process.js';
it('launches a persisted project Codex session, records its id and excludes host credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-repair-'));
  const previous = process.env.HARNESS_CODEX_BINARY;
  process.env.HARNESS_CODEX_BINARY = process.execPath;
  const run = vi.fn(async (_args: string[], options: CommandOptions) => {
    options.onLine?.('{"type":"thread.started","thread_id":"session-test"}');
    return { code: 0, output: 'finished', timedOut: false };
  });
  try {
    const config = { sourceRoot: root, stateDirectory: join(root, 'evidence'), runTimeoutMs: 5000 } as HarnessConfig;
    const result = await repairWithCodex(config, { input: 'business context', sessionId: 'fault-1', workingDirectory: root, maxIterations: 1 }, 'crash', new AbortController().signal, run);
    const [args, options] = run.mock.calls[0];
    expect(args.slice(1, 4)).toEqual(['exec', '--cd', root]);
    expect(args).not.toContain('--ephemeral');
    expect(options.env?.AGENT_HARNESS_AUTOSTART).toBe('0');
    expect(options.env?.AGENT_API_KEY).toBeUndefined();
    expect(JSON.parse(await readFile(join(result.runDirectory, 'codex-session.json'), 'utf8')).threadId).toBe('session-test');
    expect(result.detail).toContain('review');
    // A second repair can acquire the lock after completion.
    await repairWithCodex(config, { input: '', sessionId: 'fault-2', workingDirectory: root, maxIterations: 1 }, 'crash', new AbortController().signal, run);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CODEX_BINARY; else process.env.HARNESS_CODEX_BINARY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

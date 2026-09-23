import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyze, type QualityRun } from './quality-analysis.js';
import { QualityStore, sourceVersion } from './quality-store.js';

function run(id: string, sessionId = id, runtimeVersion = 'v1'): QualityRun {
  return { id, sessionId, runtimeVersion, sourceVersion: 'source1', owner: 'test', startedAt: Date.now(), updatedAt: Date.now(),
    outcome: 'completed', endedAt: Date.now(), model: 'model1', task: 'test', observations: [], dropped: 0, findings: [],
    steps: 0, iterations: 1, compactions: 0, peakContextRatio: 0.1 };
}
function call(q: QualityRun, index: number, result: string, tool = 'read') {
  q.observations.push({ at: index, type: 'tool_call', tool, callId: String(index), argumentsHash: tool },
    { at: index, type: 'tool_result', callId: String(index), resultHash: result, preview: result }); q.steps++;
}
describe('cross-session quality evidence', () => {
  it('versions the desktop AI Hub relay and Chrome bridge used by observed model runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quality-source-version-'));
    const write = (path: string, content: string) => {
      const target = join(dir, path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    };
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      write('packages/core/src/index.ts', 'export const core = 1;\n');
      write('packages/desktop/main/ai-hub/manager.ts', 'export const relay = 1;\n');
      write('packages/desktop/chrome-extension/page-actions.js', 'const bridge = 1;\n');
      write('unrelated.txt', 'first\n');

      const initial = sourceVersion(dir);
      write('packages/desktop/main/ai-hub/manager.ts', 'export const relay = 2;\n');
      const afterDesktopRelay = sourceVersion(dir);
      write('packages/desktop/chrome-extension/page-actions.js', 'const bridge = 2;\n');
      const afterChromeBridge = sourceVersion(dir);
      write('unrelated.txt', 'second\n');

      expect(initial).not.toBe('unknown');
      expect(afterDesktopRelay).not.toBe(initial);
      expect(afterChromeBridge).not.toBe(afterDesktopRelay);
      expect(sourceVersion(dir)).toBe(afterChromeBridge);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags identical completed calls, but not polling whose result changes', () => {
    const a = run('a'), b = run('b');
    for (let i = 0; i < 3; i++) { call(a, i, 'same'); call(b, i, `progress-${i}`); }
    expect(analyze(a).some(f => f.kind === 'repeated-tool')).toBe(true);
    expect(analyze(b)).toEqual([]);
  });
  it('detects cycles while events continue, errors and compaction rereads', () => {
    const q = run('a');
    for (let i = 0; i < 6; i++) call(q, i, 'same', i % 2 ? 'search' : 'read');
    q.observations.push({ at: 7, type: 'compacted' }); call(q, 8, 'same', 'read');
    q.observations.push({ at: 9, type: 'error', code: 'context_limit', message: 'context exceeded' });
    expect(analyze(q).map(f => f.kind)).toEqual(expect.arrayContaining(['step-cycle', 'reread-after-compaction', 'agent-error']));
  });
  it('separates structured environment failures from repairable agent errors', () => {
    const offline = run('offline');
    offline.observations.push({ at: 1, type: 'error', code: 'desktop_offline', message: 'AI Hub desktop offline' });
    const timeout = run('timeout');
    timeout.observations.push({ at: 1, type: 'error', code: 'model_transport_timeout', message: 'The operation was aborted due to timeout' });
    const contextLimit = run('context-limit');
    contextLimit.observations.push({ at: 1, type: 'error', code: 'context_limit', message: 'context exceeded' });
    const generic = run('generic');
    generic.observations.push({ at: 1, type: 'error', message: 'application invariant failed' });

    expect(analyze(offline)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(timeout)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(contextLimit)).toMatchObject([{ kind: 'agent-error', severe: false }]);
    expect(analyze(generic)).toMatchObject([{ kind: 'agent-error', severe: false }]);
  });
  it('persists across owners/restarts, counts sessions rather than turns, and separates runtime cohorts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quality-store-'));
    try {
      const first = new QualityStore(dir); const second = new QualityStore(dir);
      for (const [id, session] of [['a', 's1'], ['b', 's1'], ['c', 's2'], ['d', 's3']]) {
        const q = run(id, session); for (let i = 0; i < 3; i++) call(q, i, 'same'); q.findings = analyze(q); first.save(q);
      }
      second.save(run('new', 's4', 'v2'));
      const stats = new QualityStore(dir).summarize();
      expect(stats.sessions).toBe(4); expect(stats.issues[0].sessions).toBe(3);
      expect(stats.issues[0].cohorts.find(c => c.runtimeVersion === 'v2')?.rate).toBe(0);
      expect(first.claim('issue-v1')).toBe(true); expect(second.claim('issue-v1')).toBe(false);
      expect(second.claim('issue-v2')).toBe(true);
      const evidence = second.evidence(stats.issues[0].key);
      expect(evidence.representatives.length).toBe(3); expect(evidence.counterexamples.length).toBe(1);
      expect(JSON.parse(second.serializeEvidence(evidence)).limitations).toContain('No automatic');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

import { vi } from 'vitest';
import { HarnessCompanion } from './daemon-service.js';
import type { HarnessConfig } from './supervisor.js';
it('dispatches across three distinct sessions, survives restart, and does not blame a clean new runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-companion-'));
  const repair = vi.fn(async () => ({ status: 'blocked' as const, runDirectory: dir, attempts: [], detail: 'review required' }));
  const config = { sourceRoot: process.cwd(), idleTimeoutMs: 10000 } as HarnessConfig;
  const store = new QualityStore(dir);
  let service = new HarnessCompanion(config, () => {}, repair, store);
  const finish = (id: string, sessionId: string, version = 'v1', repeat = true) => {
    service.receive({ type: 'begin', id, sessionId, input: 'test', workingDirectory: '/tmp', runtimeVersion: version });
    for (let i = 0; i < (repeat ? 3 : 1); i++) {
      service.receive({ type: 'progress', id, eventType: 'tool_call', data: { type: 'tool_call', tool: 'read', callId: String(i), argumentsHash: 'same' } });
      service.receive({ type: 'progress', id, eventType: 'tool_result', data: { type: 'tool_result', callId: String(i), resultHash: 'same' } });
    }
    service.receive({ type: 'progress', id, eventType: 'done', data: { type: 'done' } });
    service.receive({ type: 'end', id });
  };
  try {
    finish('1', 'session1'); finish('2', 'session1'); finish('3', 'session2');
    expect(repair).not.toHaveBeenCalled();
    finish('4', 'session3'); await new Promise(resolve => setTimeout(resolve, 0));
    expect(repair).toHaveBeenCalledTimes(1);
    const packet = JSON.parse(repair.mock.calls[0][1]); expect(packet.representatives.length).toBe(3);
    await service.close(); service = new HarnessCompanion(config, () => {}, repair, new QualityStore(dir));
    finish('5', 'session4'); finish('6', 'session5', 'v2', false);
    expect(repair).toHaveBeenCalledTimes(1);
    const state = store.summarize(); expect(state.repairs.length).toBe(1);
    expect(state.issues[0].cohorts.find(cohort => cohort.runtimeVersion === 'v2')?.rate).toBe(0);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
it('sends an emitted error for immediate diagnosis without waiting for another session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-error-'));
  const repair = vi.fn(async () => ({ status: 'blocked' as const, runDirectory: dir, attempts: [], detail: 'review required' }));
  const service = new HarnessCompanion({ sourceRoot: process.cwd(), idleTimeoutMs: 1000 } as HarnessConfig, () => {}, repair, new QualityStore(dir));
  try {
    service.receive({ type: 'begin', id: 'one', sessionId: 's', input: 'test', workingDirectory: '/tmp', runtimeVersion: 'v1' });
    service.receive({ type: 'progress', id: 'one', eventType: 'error', data: { type: 'error', code: 'context_limit', message: 'exceeded' } });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(JSON.parse(repair.mock.calls[0][1]).summary.sessions).toBe(1);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
it.each([
  ['desktop offline', 'desktop_offline', 'AI Hub desktop offline'],
  ['model transport timeout', 'model_transport_timeout', 'The operation was aborted due to timeout'],
])('records repeated %s runs without dispatching a source repair', async (_label, code, message) => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-environment-error-'));
  const repair = vi.fn(async () => ({ status: 'blocked' as const, runDirectory: dir, attempts: [], detail: 'review required' }));
  const store = new QualityStore(dir);
  const service = new HarnessCompanion({ sourceRoot: process.cwd(), idleTimeoutMs: 1000 } as HarnessConfig, () => {}, repair, store);
  try {
    for (let index = 0; index < 3; index++) {
      const id = `offline-${index}`;
      service.receive({ type: 'begin', id, sessionId: id, input: 'test', workingDirectory: '/tmp', runtimeVersion: 'v1' });
      service.receive({ type: 'progress', id, eventType: 'error', data: {
        type: 'error', code, message,
      } });
      service.receive({ type: 'end', id });
    }

    expect(repair).not.toHaveBeenCalled();
    expect(store.summarize().issues.find(issue => issue.kind === 'environment-error')?.sessions).toBe(3);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
it('reviews a batch of healthy sessions and defers when another Codex writer owns the checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-periodic-'));
  const store = new QualityStore(dir);
  for (let i = 0; i < 19; i++) store.save(run(`healthy-${i}`, `session-${i}`));
  const repair = vi.fn(async () => ({ status: 'blocked' as const, runDirectory: dir, attempts: [], detail: 'Another Codex repair owns the checkout' }));
  const service = new HarnessCompanion({ sourceRoot: process.cwd(), idleTimeoutMs: 1000 } as HarnessConfig, () => {}, repair, store);
  try {
    service.receive({ type: 'begin', id: 'last', sessionId: 'last', input: 'test', workingDirectory: '/tmp', runtimeVersion: 'v1' });
    service.receive({ type: 'observation', sessionId: 'last', data: { type: 'request_context', providerId: '', modelId: 'model1' } });
    // Match the existing cohort exactly.
    for (const q of store.runs().filter(q => q.id !== 'last')) { q.model = '/model1'; store.save(q); }
    service.receive({ type: 'progress', id: 'last', eventType: 'done', data: { type: 'done' } });
    service.receive({ type: 'end', id: 'last' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(repair).toHaveBeenCalledTimes(1);
    expect(JSON.parse(repair.mock.calls[0][1]).hypothesis).toBe('periodic-review:1');
    service.tick(Date.now() + 61_000);
    expect(repair).toHaveBeenCalledTimes(2);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

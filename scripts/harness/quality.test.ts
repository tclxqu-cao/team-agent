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
function call(q: QualityRun, index: number, result: string, tool = 'read', isError = false) {
  q.observations.push({ at: index, type: 'tool_call', tool, callId: String(index), argumentsHash: tool },
    { at: index, type: 'tool_result', callId: String(index), resultHash: result, preview: result, ...(isError ? { isError: true } : {}) }); q.steps++;
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
  it('ignores a bounded wait_agent timeout when a later poll completes', () => {
    const q = run('wait-timeout-then-complete');
    call(q, 1, 'Error: wait_agent timed out', 'wait_agent', true);
    call(q, 2, JSON.stringify({ status: 'completed', summary: 'done' }), 'wait_agent');

    expect(analyze(q)).toEqual([]);
  });
  it('does not treat repeated bounded wait_agent timeouts as wasted work or a step cycle', () => {
    const q = run('repeated-wait-timeouts');
    for (let i = 0; i < 6; i++) call(q, i, 'Error: wait_agent timed out', 'wait_agent', true);
    call(q, 7, JSON.stringify({ status: 'completed', summary: 'done' }), 'wait_agent');

    expect(analyze(q)).toEqual([]);
  });
  it('retains genuine wait_agent and non-wait timeout failures as counterexamples', () => {
    const childFailure = run('child-failure');
    call(childFailure, 1, JSON.stringify({
      status: 'failed', code: 'AGENT_TIMEOUT', error: 'Sub-agent exceeded its execution budget',
    }), 'wait_agent', true);
    const bashFailure = run('bash-timeout');
    call(bashFailure, 1, 'Error: wait_agent timed out', 'bash', true);

    expect(analyze(childFailure)).toMatchObject([{ kind: 'tool-error', severe: false }]);
    expect(analyze(bashFailure)).toMatchObject([{ kind: 'tool-error', severe: false }]);
  });
  it.each([
    ['one bounded wait', [
      { at: 1, type: 'tool_call', tool: 'wait_agent', callId: 'wait-a', argumentsHash: 'agent-a' },
      { at: 2, type: 'tool_result', callId: 'wait-a', resultHash: 'timeout', isError: true, preview: 'Error: wait_agent timed out' },
    ]],
    ['parallel bounded waits', [
      { at: 1, type: 'tool_call', tool: 'wait_agent', callId: 'wait-a', argumentsHash: 'agent-a' },
      { at: 1, type: 'tool_call', tool: 'wait_agent', callId: 'wait-b', argumentsHash: 'agent-b' },
      { at: 2, type: 'tool_result', callId: 'wait-a', resultHash: 'timeout', isError: true, preview: 'Error: wait_agent timed out' },
      { at: 2, type: 'tool_result', callId: 'wait-b', resultHash: 'timeout', isError: true, preview: 'Error: wait_agent timed out' },
    ]],
    ['a bounded wait followed by completion', [
      { at: 1, type: 'tool_call', tool: 'wait_agent', callId: 'wait-a-1', argumentsHash: 'agent-a' },
      { at: 2, type: 'tool_result', callId: 'wait-a-1', resultHash: 'timeout', isError: true, preview: 'Error: wait_agent timed out' },
      { at: 3, type: 'tool_call', tool: 'wait_agent', callId: 'wait-a-2', argumentsHash: 'agent-a' },
      { at: 4, type: 'tool_result', callId: 'wait-a-2', resultHash: 'completed', isError: false, preview: '{"status":"completed"}' },
    ]],
  ])('does not classify %s as a tool error', (_label, observations) => {
    const q = run('polling');
    q.observations.push(...observations);
    expect(analyze(q)).toEqual([]);
  });
  it('keeps genuine wait_agent and other tool failures as tool errors', () => {
    const missingAgent = run('missing-agent');
    missingAgent.observations.push(
      { at: 1, type: 'tool_call', tool: 'wait_agent', callId: 'wait', argumentsHash: 'missing' },
      { at: 2, type: 'tool_result', callId: 'wait', resultHash: 'missing', isError: true,
        preview: 'Error: No running sub-agent found' },
    );
    const bashTimeout = run('bash-timeout');
    bashTimeout.observations.push(
      { at: 1, type: 'tool_call', tool: 'bash', callId: 'bash', argumentsHash: 'sleep' },
      { at: 2, type: 'tool_result', callId: 'bash', resultHash: 'timeout', isError: true,
        preview: 'Error: wait_agent timed out' },
    );

    expect(analyze(missingAgent)).toMatchObject([{ kind: 'tool-error' }]);
    expect(analyze(bashTimeout)).toMatchObject([{ kind: 'tool-error' }]);
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
    const aiHubTimeout = run('aihub-timeout');
    aiHubTimeout.observations.push({ at: 1, type: 'error', code: 'model_request_timeout',
      message: 'AI Hub 抓取回复超过 240 秒（deepseek）：站点可能未登录、被限流或选择器漂移' });
    const apiProviderTimeout = run('api-provider-timeout');
    apiProviderTimeout.observations.push({ at: 1, type: 'error', code: 'model_request_timeout',
      message: 'OpenAI 单次请求超过 120 秒，已停止等待' });
    const openAiAuth = run('openai-auth');
    openAiAuth.observations.push({ at: 1, type: 'error', message: 'OpenAI API error 401: {"error":{"message":"Incorrect API key provided","type":"invalid_api_key"}}' });
    const anthropicAuth = run('anthropic-auth');
    anthropicAuth.observations.push({ at: 1, type: 'error', message: 'Anthropic API error 401: authentication_error: invalid x-api-key' });
    const openAiCapacity = run('openai-capacity');
    openAiCapacity.observations.push({ at: 1, type: 'error', message: 'OpenAI API error 429: {"error":{"message":"concurrency reached, current: 6, limit: 5","type":"rate_limited"}}' });
    const anthropicCapacity = run('anthropic-capacity');
    anthropicCapacity.observations.push({ at: 1, type: 'error', message: 'Anthropic API error 529: {"error":{"type":"overloaded_error","message":"Overloaded"}}' });
    const structuredCapacity = run('structured-capacity');
    structuredCapacity.observations.push({ at: 1, type: 'error', code: 'rate_limit_error', message: 'request throttled' });
    const contextLimit = run('context-limit');
    contextLimit.observations.push({ at: 1, type: 'error', code: 'context_limit', message: 'context exceeded' });
    const generic = run('generic');
    generic.observations.push({ at: 1, type: 'error', message: 'application invariant failed after HTTP 401' });
    const generic429 = run('generic-429');
    generic429.observations.push({ at: 1, type: 'error', message: 'application invariant failed after HTTP 429' });
    const internalConcurrency = run('internal-concurrency');
    internalConcurrency.observations.push({ at: 1, type: 'error', message: 'internal semaphore: concurrency reached unexpectedly' });

    expect(analyze(offline)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(timeout)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(aiHubTimeout)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(apiProviderTimeout)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(openAiAuth)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(anthropicAuth)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(openAiCapacity)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(anthropicCapacity)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(structuredCapacity)).toMatchObject([{ kind: 'environment-error', severe: false }]);
    expect(analyze(contextLimit)).toMatchObject([{ kind: 'agent-error', severe: false }]);
    expect(analyze(generic)).toMatchObject([{ kind: 'agent-error', severe: false }]);
    expect(analyze(generic429)).toMatchObject([{ kind: 'agent-error', severe: false }]);
    expect(analyze(internalConcurrency)).toMatchObject([{ kind: 'agent-error', severe: false }]);
  });
  it.each([
    ['bash', 'shell operators are denied by the selected policy'],
    ['bash', 'executable is not allowed by the selected policy'],
    ['glob', 'read path is outside the allowed roots'],
    ['read_file', 'requested read path does not exist'],
  ])('records %s policy enforcement separately from repairable tool failures', (tool, message) => {
    const q = run(`policy-${tool}-${message}`);
    call(q, 1, JSON.stringify({ code: 'TOOL_POLICY_DENIED', message }), tool, true);
    expect(analyze(q)).toMatchObject([{ kind: 'policy-denial', severe: false }]);
  });
  it('keeps genuine and unstructured tool failures repairable', () => {
    const structured = run('structured-tool-error');
    call(structured, 1, JSON.stringify({ code: 'EIO', message: 'disk read failed' }), 'read_file', true);
    const unstructured = run('unstructured-tool-error');
    call(unstructured, 1, 'Error: TOOL_POLICY_DENIED was mentioned by the command', 'bash', true);

    expect(analyze(structured)).toMatchObject([{ kind: 'tool-error', severe: false }]);
    expect(analyze(unstructured)).toMatchObject([{ kind: 'tool-error', severe: false }]);
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
it('records invalid model credentials without dispatching a source repair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-model-auth-error-'));
  const repair = vi.fn(async () => ({ status: 'blocked' as const, runDirectory: dir, attempts: [], detail: 'review required' }));
  const store = new QualityStore(dir);
  const service = new HarnessCompanion({ sourceRoot: process.cwd(), idleTimeoutMs: 1000 } as HarnessConfig, () => {}, repair, store);
  try {
    service.receive({ type: 'begin', id: 'auth', sessionId: 'auth-session', input: 'test', workingDirectory: '/tmp', runtimeVersion: 'v1' });
    service.receive({ type: 'progress', id: 'auth', eventType: 'error', data: {
      type: 'error',
      message: 'OpenAI API error 401: {"error":{"message":"Incorrect API key provided","type":"invalid_api_key"}}',
    } });

    expect(repair).not.toHaveBeenCalled();
    expect(store.summarize().issues).toMatchObject([{ kind: 'environment-error', sessions: 1 }]);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
it('records provider capacity exhaustion without dispatching a source repair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-model-capacity-error-'));
  const repair = vi.fn(async () => ({ status: 'blocked' as const, runDirectory: dir, attempts: [], detail: 'review required' }));
  const store = new QualityStore(dir);
  const service = new HarnessCompanion({ sourceRoot: process.cwd(), idleTimeoutMs: 1000 } as HarnessConfig, () => {}, repair, store);
  try {
    service.receive({ type: 'begin', id: 'capacity', sessionId: 'capacity-session', input: 'test', workingDirectory: '/tmp', runtimeVersion: 'v1' });
    service.receive({ type: 'progress', id: 'capacity', eventType: 'error', data: {
      type: 'error',
      message: 'OpenAI API error 429: {"error":{"message":"concurrency reached, current: 6, limit: 5","type":"rate_limited"}}',
    } });

    expect(repair).not.toHaveBeenCalled();
    expect(store.summarize().issues).toMatchObject([{ kind: 'environment-error', sessions: 1 }]);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
it('does not dispatch a repair for bounded wait_agent polling across sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-wait-agent-polling-'));
  const repair = vi.fn(async () => ({ status: 'blocked' as const, runDirectory: dir, attempts: [], detail: 'review required' }));
  const store = new QualityStore(dir);
  const service = new HarnessCompanion({ sourceRoot: process.cwd(), idleTimeoutMs: 1000 } as HarnessConfig, () => {}, repair, store);
  try {
    for (let index = 0; index < 3; index++) {
      const id = `poll-${index}`;
      service.receive({ type: 'begin', id, sessionId: id, input: 'test', workingDirectory: '/tmp', runtimeVersion: 'v1' });
      service.receive({ type: 'progress', id, eventType: 'tool_call', data: {
        type: 'tool_call', tool: 'wait_agent', callId: `wait-${index}`, argumentsHash: `agent-${index}`,
      } });
      service.receive({ type: 'progress', id, eventType: 'tool_result', data: {
        type: 'tool_result', callId: `wait-${index}`, resultHash: 'timeout', isError: true,
        preview: 'Error: wait_agent timed out',
      } });
      service.receive({ type: 'progress', id, eventType: 'done', data: { type: 'done' } });
      service.receive({ type: 'end', id });
    }

    expect(repair).not.toHaveBeenCalled();
    expect(store.summarize().issues).toEqual([]);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
it.each([
  ['desktop offline', 'desktop_offline', 'AI Hub desktop offline'],
  ['provider request timeout', 'model_request_timeout', 'AI Hub capture timed out'],
  ['model transport timeout', 'model_transport_timeout', 'The operation was aborted due to timeout'],
  ['model rate limit', 'rate_limited', 'request throttled'],
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
it('does not dispatch recurring policy denials but still dispatches recurring genuine tool errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-policy-denial-'));
  const repair = vi.fn(async () => ({ status: 'blocked' as const, runDirectory: dir, attempts: [], detail: 'review required' }));
  const store = new QualityStore(dir);
  const service = new HarnessCompanion({ sourceRoot: process.cwd(), idleTimeoutMs: 1000 } as HarnessConfig, () => {}, repair, store);
  const finish = (id: string, preview: string) => {
    service.receive({ type: 'begin', id, sessionId: id, input: 'test', workingDirectory: '/tmp', runtimeVersion: 'v1' });
    service.receive({ type: 'progress', id, eventType: 'tool_call', data: {
      type: 'tool_call', tool: 'bash', callId: id, argumentsHash: 'same',
    } });
    service.receive({ type: 'progress', id, eventType: 'tool_result', data: {
      type: 'tool_result', callId: id, resultHash: preview, preview, isError: true,
    } });
    service.receive({ type: 'progress', id, eventType: 'done', data: { type: 'done' } });
    service.receive({ type: 'end', id });
  };
  try {
    const denial = JSON.stringify({ code: 'TOOL_POLICY_DENIED', message: 'shell operators are denied by the selected policy' });
    for (let index = 0; index < 3; index++) finish(`denial-${index}`, denial);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(repair).not.toHaveBeenCalled();
    expect(store.summarize().issues.find(issue => issue.kind === 'policy-denial')?.sessions).toBe(3);

    for (let index = 0; index < 3; index++) finish(`failure-${index}`, 'command exited with status 2');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(repair).toHaveBeenCalledTimes(1);
    expect(JSON.parse(repair.mock.calls[0][1]).hypothesis).toMatch(/^tool-error:/);
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

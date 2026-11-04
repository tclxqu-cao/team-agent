import { describe, expect, it } from 'vitest';
import { classifyRunError, createRunResult, normalizeTokenUsage, runResultLabel } from './run-result.js';
import { RunUsageAccumulator } from './run-usage.js';

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
});

describe('run results', () => {
  it.each([
    ['MODEL_HTTP_401', 'invalid API key', 'auth_required'],
    ['MODEL_HTTP_403', 'Forbidden', 'permission_denied'],
    ['MODEL_HTTP_429', 'Too many requests', 'rate_limited'],
    ['MODEL_HTTP_429', 'insufficient_quota', 'quota_exceeded'],
    ['MODEL_HTTP_503', 'Service Unavailable', 'provider_error'],
    [undefined, 'credit balance too low', 'quota_exceeded'],
    ['context_limit', 'input too long', 'context_limit'],
    [undefined, 'max_tokens output truncated', 'output_limit'],
    ['model_request_timeout', 'slow request', 'timeout'],
    [undefined, 'fetch failed: ECONNRESET', 'network_error'],
    ['NATIVE_PROTOCOL_ERROR', 'Native runtime restarted; this turn was interrupted.', 'runtime_interrupted'],
    [undefined, 'socket disconnected', 'runtime_interrupted'],
    ['NATIVE_PROTOCOL_ERROR', 'Codex turn was interrupted.', 'runtime_interrupted'],
    ['NATIVE_ABORTED', 'Stopped by user', 'user_cancelled'],
    ['NATIVE_RUNTIME_UNAVAILABLE', 'missing engine', 'runtime_unavailable'],
    ['tool_arguments_invalid', 'bad response', 'protocol_error'],
    [undefined, 'unrecognized upstream failure', 'unknown_error'],
  ])('classifies %s / %s as %s', (code, message, expected) => {
    expect(classifyRunError(message, code)).toBe(expected);
  });

  it('records safe summaries without copying the raw upstream message', () => {
    const result = createRunResult({ type: 'error', message: 'invalid API key: secret-123' }, {
      durationMs: 125.6, runId: 'run-1',
    });
    expect(result).toEqual({ status: 'failed', reason: 'auth_required', durationMs: 126, runId: 'run-1' });
    expect(runResultLabel(result)).toBe('运行失败：需要重新登录或检查凭据');
    expect(JSON.stringify(result)).not.toContain('secret-123');
  });

  it('distinguishes user cancellation from a runtime interruption', () => {
    expect(createRunResult({ type: 'error', code: 'NATIVE_ABORTED', message: 'aborted' }, { durationMs: 10 }).status).toBe('cancelled');
    expect(createRunResult({ type: 'error', message: 'runtime restarted' }, { durationMs: 10 }).status).toBe('interrupted');
    expect(createRunResult({ type: 'error', message: 'transport closed after stop' }, { durationMs: 10, cancelled: true }).reason).toBe('user_cancelled');
    expect(createRunResult({ type: 'turn_aborted' }, { durationMs: -1 })).toMatchObject({ status: 'cancelled', durationMs: 0 });
  });

  it('preserves the first outcome carried by a done event and does not infer missing usage', () => {
    const failed = createRunResult({ type: 'error', code: 'MODEL_HTTP_429', message: 'rate limit' }, { durationMs: 5 });
    expect(createRunResult({ type: 'done', finalText: '', result: failed }, { durationMs: 20 })).toMatchObject({ status: 'failed', reason: 'rate_limited' });
    expect(createRunResult({ type: 'done', finalText: 'OK' }, { durationMs: NaN })).toEqual({ status: 'completed', reason: 'completed', durationMs: 0 });
  });

  it('keeps real zero counts, ignores invalid counts, and never adds cache twice', () => {
    expect(normalizeTokenUsage(usage(0, 0))).toEqual(usage(0, 0));
    for (const inputTokens of [-1, Infinity, NaN, 1.5]) expect(normalizeTokenUsage(usage(inputTokens, 1))).toBeUndefined();
    expect(normalizeTokenUsage({ inputTokens: 100 })).toBeUndefined();
    expect(normalizeTokenUsage({ ...usage(100, 20), totalTokens: 999, cacheReadTokens: 60, cacheWriteTokens: 10, source: 'runtime', coverage: 'partial' })).toEqual({
      ...usage(100, 20), cacheReadTokens: 60, cacheWriteTokens: 10, source: 'runtime', coverage: 'partial',
    });
    expect(normalizeTokenUsage({ ...usage(10, 1), cacheReadTokens: 100 })).toEqual(usage(10, 1));
  });
});

describe('per-run reported usage', () => {
  it('replaces repeated snapshots in one request and sums distinct requests', () => {
    const meter = new RunUsageAccumulator();
    meter.beginRequest();
    meter.observe(usage(10, 1));
    meter.observe(usage(10, 4));
    expect(meter.snapshot()).toMatchObject({ ...usage(10, 4), coverage: 'complete' });
    meter.finishRequest();
    meter.finishRequest();
    meter.beginRequest();
    meter.observe({ ...usage(20, 6), cacheReadTokens: 15 });
    meter.finishRequest();
    expect(meter.snapshot()).toEqual({ ...usage(30, 10), cacheReadTokens: 15, source: 'provider', coverage: 'complete' });
  });

  it('leaves wholly unknown usage absent and labels incomplete coverage', () => {
    const meter = new RunUsageAccumulator();
    meter.beginRequest();
    meter.finishRequest();
    expect(meter.snapshot()).toBeUndefined();
    meter.beginRequest();
    meter.observe(usage(12, 3));
    meter.finishRequest();
    expect(meter.snapshot()).toEqual({ ...usage(12, 3), source: 'provider', coverage: 'partial' });
  });

  it('marks compaction, restored runs and partial request reports as partial', () => {
    const meter = new RunUsageAccumulator();
    meter.beginRequest();
    meter.observe(usage(1, 2));
    meter.finishRequest();
    meter.markPartial();
    expect(meter.snapshot()?.coverage).toBe('partial');
    const partial = new RunUsageAccumulator();
    partial.beginRequest();
    partial.observe({ ...usage(3, 4), coverage: 'partial' });
    expect(partial.snapshot()?.coverage).toBe('partial');
  });
});

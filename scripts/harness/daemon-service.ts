import { createHash, randomUUID } from 'node:crypto';
import { repairWithCodex } from './codex-repair.js';
import { analyze, type QualityRun, type Observation } from './quality-analysis.js';
import { QualityStore, sourceVersion } from './quality-store.js';
import { type HarnessConfig, type HarnessResult, type HarnessTask } from './supervisor.js';

interface WatchedTask { task: HarnessTask; lastProgress: number; waiting: boolean; trace: string[]; reported: boolean; quality?: QualityRun; savedAt: number }
export interface CompanionStatus { state: 'waiting-model' | 'ready' | 'repairing' | 'stopped'; modelId?: string; detail?: string; quality?: unknown }
export class HarnessCompanion {
  private readonly runs = new Map<string, WatchedTask>();
  private readonly fingerprints = new Set<string>();
  private readonly queue: Array<{ task: HarnessTask; message: string; claim?: string }> = [];
  private readonly abort = new AbortController();
  private busy = false;
  private readonly deferred: Array<{ job: { task: HarnessTask; message: string; claim?: string }; after: number }> = [];
  private lastDetail: string | undefined;
  private qualitySummary: unknown;
  private lastRefresh = 0;
  private draining: Promise<void> = Promise.resolve();

  constructor(private readonly config: HarnessConfig,
    private readonly publish: (status: CompanionStatus) => void,
    private readonly repair: (task: HarnessTask, message: string, signal: AbortSignal) => Promise<HarnessResult> =
      (task, message, signal) => repairWithCodex(config, task, message, signal),
    private readonly store?: QualityStore) { this.refresh(); this.status(); }

  private status(detail?: string) {
    if (detail !== undefined) this.lastDetail = detail;
    this.publish({ state: this.abort.signal.aborted ? 'stopped' : this.busy ? 'repairing' : 'ready',
      detail: this.lastDetail, quality: this.qualitySummary });
  }

  receive(message: Record<string, unknown>): void {
    if (this.abort.signal.aborted) return;
    if (message.type === 'configure') {
      return; // Codex uses its own configuration and login; host credentials are ignored.
    }
    if (message.type === 'waiting' && typeof message.sessionId === 'string') {
      for (const run of this.runs.values()) if (run.task.sessionId === message.sessionId) {
        run.waiting = message.waiting === true; run.lastProgress = Date.now();
      }
      return;
    }
    if (message.type === 'observation' && typeof message.sessionId === 'string') {
      for (const run of this.runs.values()) if (run.task.sessionId === message.sessionId) this.observe(run, message.data);
      return;
    }
    const id = typeof message.id === 'string' ? message.id : '';
    if (!id) return;
    if (message.type === 'begin') {
      if (this.runs.size >= 32 || typeof message.input !== 'string' || message.input.length > 100_000 ||
          typeof message.sessionId !== 'string' || typeof message.workingDirectory !== 'string') return;
      this.runs.set(id, { task: { input: message.input, sessionId: message.sessionId,
        workingDirectory: message.workingDirectory, maxIterations: 30 }, lastProgress: Date.now(), waiting: false, trace: [], reported: false, savedAt: 0,
        quality: this.store ? { daemonPid: process.pid, id, sessionId: message.sessionId, owner: String(message.owner ?? 'unknown'), startedAt: Date.now(), updatedAt: Date.now(),
          outcome: 'running', runtimeVersion: String(message.runtimeVersion ?? 'unknown'), sourceVersion: sourceVersion(this.config.sourceRoot),
          model: 'unknown', task: message.input.slice(0, 8000), observations: [], dropped: 0, findings: [],
          steps: 0, iterations: 0, compactions: 0, peakContextRatio: 0 } : undefined });
    }
    const run = this.runs.get(id);
    if (!run) return;
    if (message.type === 'begin') this.persist(run);
    if (message.type === 'progress') {
      run.lastProgress = Date.now();
      if (message.waiting === true) run.waiting = true;
      if (['tool_result', 'approval_resolved'].includes(String(message.eventType))) run.waiting = false;
      run.trace.push(`${String(message.eventType)}${message.tool ? `: ${String(message.tool)}` : ''}`);
      run.trace = run.trace.slice(-30);
      this.observe(run, message.data ?? { type: message.eventType });
    } else if (message.type === 'fault') {
      if (run.quality) this.observe(run, { type: 'fault', message: String(message.message).slice(-16_000) });
      else this.report(run, String(message.message).slice(-16_000));
    } else if (message.type === 'end') {
      if (run.quality) {
        run.quality.endedAt = Date.now();
        if (run.quality.outcome === 'running') run.quality.outcome = 'interrupted';
        this.persist(run); this.evaluate(run); this.refresh(); this.status();
      }
      this.runs.delete(id);
    }
  }

  tick(now = Date.now()): void {
    if (this.store && now - this.lastRefresh > 30_000) {
      this.lastRefresh = now;
      const previous = JSON.stringify(this.qualitySummary); this.refresh();
      if (previous !== JSON.stringify(this.qualitySummary)) this.status();
    }
    for (let index = this.deferred.length - 1; index >= 0; index--) {
      if (this.deferred[index].after <= now && this.queue.length < 4) this.queue.push(this.deferred.splice(index, 1)[0].job);
    }
    if (!this.busy && this.queue.length) this.draining = this.drain();
    for (const run of this.runs.values()) {
      if (!run.waiting && now - run.lastProgress > this.config.idleTimeoutMs && !run.reported) {
        if (run.quality) { this.observe(run, { type: 'watchdog' }); run.reported = true; }
        else this.report(run, 'Harness made no observable progress before the watchdog deadline');
      }
    }
  }

  private refresh(): void {
    if (this.store) this.qualitySummary = this.store.summarize();
  }

  private observe(run: WatchedTask, value: unknown): void {
    const q = run.quality;
    if (!q || !value || typeof value !== 'object') return;
    const event = { ...value, at: Date.now() } as Observation;
    if (typeof event.type !== 'string') return;
    // Text chunks only maintain heartbeat; retain structural steps and bounded previews.
    if (['text_chunk', 'text_done', 'thinking', 'reasoning_summary_delta'].includes(event.type)) return;
    q.observations.push(event);
    while (q.observations.length > 200 || (q.observations.length > 1 && JSON.stringify(q.observations).length > 128_000)) { q.observations.shift(); q.dropped++; }
    q.updatedAt = Date.now();
    if (event.type === 'tool_call') q.steps++;
    if (event.type === 'compacted') q.compactions++;
    if (event.type === 'request_context') { q.iterations = Number(event.iteration) || q.iterations; q.model = `${event.providerId}/${event.modelId}`; }
    if (event.type === 'context_usage') {
      const usage = event.usage as { requestIndex?: number; providerId?: string; modelId?: string; ratio?: number } | undefined;
      if (usage) { q.iterations = usage.requestIndex ?? q.iterations; q.model = `${usage.providerId}/${usage.modelId}`;
        q.peakContextRatio = Math.max(q.peakContextRatio, usage.ratio ?? 0); }
    }
    if (event.type === 'error' || event.type === 'fault') q.outcome = 'error';
    if (event.type === 'turn_aborted') q.outcome = 'aborted';
    if (event.type === 'done' && q.outcome === 'running') q.outcome = 'completed';
    // Preserve findings already seen even after the bounded observation window rolls over.
    q.findings = [...new Map([...q.findings, ...analyze(q)].map(finding => [finding.key, finding])).values()].slice(0, 100);
    const severe = q.findings.some(finding => finding.severe) || event.type === 'error';
    if (Date.now() - run.savedAt > 1000 || severe) this.persist(run);
    if (severe && !run.reported) this.evaluate(run, true);
  }

  private persist(run: WatchedTask): void {
    if (run.quality) { this.store?.save(run.quality); run.savedAt = Date.now(); }
  }

  private evaluate(run: WatchedTask, immediate = false): void {
    if (!this.store || !run.quality || this.queue.length >= 4) return;
    const records = this.store.runs();
    const q = run.quality;
    const candidates = immediate ? q.findings.filter(item => item.severe || item.kind === 'agent-error').map(item => item.key)
      : this.store.summarize(records).issues.filter(issue => issue.cohorts.some(cohort => cohort.runtimeVersion === q.runtimeVersion && cohort.model === q.model && cohort.sessions >= 3)).map(issue => issue.key);
    const completeSessions = this.store.completedSessions(q.runtimeVersion, q.model);
    if (!immediate && completeSessions >= 20) candidates.push(`periodic-review:${Math.floor(completeSessions / 20)}`);
    let key: string | undefined, claim: string | undefined;
    for (const candidate of candidates) {
      const identity = `${candidate}:${q.runtimeVersion}:${q.model}`;
      if (this.store.claim(identity)) { key = candidate; claim = identity; break; }
    }
    if (!key || !claim) return;
    if (immediate) run.reported = true;
    const evidence = this.store.evidence(key, records);
    if (key.startsWith('periodic-review')) evidence.representatives = records.filter(record => record.endedAt).slice(0, 3).map(record => ({ ...record, observations: record.observations.slice(-30), evidenceTruncated: true }));
    this.queue.push({ task: { input: 'Diagnose the supplied cross-session Harness evidence; do not execute sampled user tasks.',
      sessionId: randomUUID(), workingDirectory: this.config.sourceRoot, maxIterations: 30 },
      message: this.store.serializeEvidence(evidence), claim });
    if (!this.busy) this.draining = this.drain();
  }

  private report(run: WatchedTask, message: string): void {
    if (run.reported) return;
    run.reported = true;
    const fingerprint = createHash('sha256').update(message).digest('hex');
    if (this.fingerprints.has(fingerprint) || this.queue.length >= 4) return;
    this.fingerprints.add(fingerprint);
    if (this.fingerprints.size > 100) this.fingerprints.delete(this.fingerprints.values().next().value!);
    this.queue.push({ task: { ...run.task, sessionId: randomUUID() },
      message: `${message}\nRecent host events:\n${run.trace.join('\n')}` });
    if (!this.busy) this.draining = this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true; this.status();
    try {
      while (this.queue.length && !this.abort.signal.aborted) {
        const job = this.queue.shift()!;
        try {
          const before = this.store ? sourceVersion(this.config.sourceRoot) : undefined;
          const result = await this.repair(job.task, job.message, this.abort.signal);
          if (job.claim && this.store) {
            if (result.detail.startsWith('Another Codex repair')) {
              this.deferred.push({ job, after: Date.now() + 60_000 });
              this.status('Codex checkout busy; diagnosis queued for retry');
              continue;
            }
            this.store.recordRepair({ claim: job.claim, at: Date.now(), sourceBefore: before, sourceAfter: sourceVersion(this.config.sourceRoot),
              runDirectory: result.runDirectory, detail: result.detail, state: result.detail.includes('failed or timed out') ? 'failed' : 'needs-observation',
              note: 'CLI completion does not prove a fix. Compare subsequent loaded-runtime cohorts; existing processes may still run old code.' });
            this.refresh();
          }
          this.status(`${result.detail}; evidence: ${result.runDirectory}`);
        } catch {
          if (job.claim && this.store) {
            this.store.recordRepair({ claim: job.claim, at: Date.now(), state: 'failed', note: 'Inspect Codex evidence and partial edits; no automatic resolved verdict' });
          }
          this.status('Repair did not complete; inspect evidence and any partial edits');
        }
      }
    } finally { this.busy = false; this.status(); }
  }

  async close(): Promise<void> {
    this.abort.abort();
    for (const job of [...this.queue, ...this.deferred.map(item => item.job)]) if (job.claim) this.store?.release(job.claim);
    this.deferred.length = 0;
    this.queue.length = 0;
    for (const run of this.runs.values()) if (run.quality) {
      run.quality.outcome = 'interrupted'; run.quality.endedAt = Date.now(); this.persist(run);
    }
    this.runs.clear();
    await this.draining; this.status();
  }
}

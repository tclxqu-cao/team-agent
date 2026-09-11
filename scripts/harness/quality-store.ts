import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { digest, type QualityRun } from './quality-analysis.js';

export function sourceVersion(root: string): string {
  try {
    const paths = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', 'packages/core/src',
      'packages/desktop/main/agent-host.ts', 'packages/server/app/api/agent-host.ts', 'packages/tui/src/runtime.ts', 'scripts/harness'],
    { cwd: root, encoding: 'utf8', maxBuffer: 2_000_000 }).split('\n').filter(Boolean);
    return digest([...new Set(paths)].sort().filter(path => !path.includes('.test.')).map(path => [path, readFileSync(join(root, path), 'utf8')]));
  } catch { return 'unknown'; }
}
export interface IssueSummary {
  key: string; kind: string; sessions: number; totalSessions: number; rate: number;
  cohorts: Array<{ runtimeVersion: string; model: string; sessions: number; totalSessions: number; rate: number; averageSteps: number; averagePeakContextRatio: number }>;
}
export class QualityStore {
  constructor(readonly directory: string, private readonly limit = 500) {
    for (const name of ['runs', 'claims', 'repairs', 'completed-sessions']) mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
  }
  private write(path: string, value: unknown) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path);
  }
  save(run: QualityRun) {
    this.write(join(this.directory, 'runs', `${digest(run.id)}.json`), run);
    if (run.endedAt && run.outcome === 'completed') {
      const path = join(this.directory, 'completed-sessions', `${digest([run.runtimeVersion, run.model])}-${digest(run.sessionId)}.json`);
      try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  completedSessions(runtimeVersion: string, model: string): number {
    const prefix = `${digest([runtimeVersion, model])}-`;
    return readdirSync(join(this.directory, 'completed-sessions')).filter(name => name.startsWith(prefix)).length;
  }
  runs(): QualityRun[] {
    const records: QualityRun[] = [];
    for (const name of readdirSync(join(this.directory, 'runs'))) {
      if (!name.endsWith('.json')) continue;
      try { records.push(JSON.parse(readFileSync(join(this.directory, 'runs', name), 'utf8'))); } catch { /* concurrently pruned */ }
    }
    for (const run of records) if (run.outcome === 'running' && run.daemonPid) {
      try { process.kill(run.daemonPid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          run.outcome = 'interrupted'; run.endedAt = run.updatedAt; this.save(run);
        }
      }
    }
    records.sort((a, b) => b.startedAt - a.startedAt);
    for (const old of records.slice(this.limit)) {
      if (old.outcome === 'running') continue;
      try { unlinkSync(join(this.directory, 'runs', `${digest(old.id)}.json`)); } catch { /* concurrent retention */ }
    }
    return records.slice(0, this.limit);
  }
  summarize(records = this.runs()): { runs: number; sessions: number; issues: IssueSummary[]; retentionRuns: number; repairs: unknown[] } {
    const ids = new Set(records.map(run => run.sessionId));
    const keys = new Map(records.flatMap(run => run.findings.map(finding => [finding.key, finding.kind] as const)));
    const issues = [...keys].map(([key, kind]) => {
      const affected = records.filter(run => run.findings.some(finding => finding.key === key));
      const sessions = new Set(affected.map(run => run.sessionId)).size;
      const cohorts = [...new Set(records.map(run => JSON.stringify([run.runtimeVersion, run.model])))].map(cohort => {
        const [runtimeVersion, model] = JSON.parse(cohort);
        const group = records.filter(run => run.runtimeVersion === runtimeVersion && run.model === model);
        const totalSessions = new Set(group.map(run => run.sessionId)).size;
        const count = new Set(group.filter(run => run.findings.some(finding => finding.key === key)).map(run => run.sessionId)).size;
        return { runtimeVersion, model, sessions: count, totalSessions, rate: count / totalSessions,
          averageSteps: group.reduce((n, run) => n + run.steps, 0) / group.length,
          averagePeakContextRatio: group.reduce((n, run) => n + run.peakContextRatio, 0) / group.length };
      });
      return { key, kind, sessions, totalSessions: ids.size, rate: sessions / ids.size, cohorts };
    }).sort((a, b) => b.sessions - a.sessions);
    const repairs = readdirSync(join(this.directory, 'repairs')).filter(name => name.endsWith('.json')).sort().slice(-20).map(name => {
      try { return JSON.parse(readFileSync(join(this.directory, 'repairs', name), 'utf8')); } catch { return null; }
    }).filter(Boolean);
    return { runs: records.length, sessions: ids.size, issues: issues.slice(0, 30).map(issue => ({ ...issue, cohorts: issue.cohorts.slice(0, 20) })), retentionRuns: this.limit, repairs };
  }
  claim(key: string): boolean {
    try {
      const fd = openSync(join(this.directory, 'claims', `${digest(key)}.json`), 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ key, at: Date.now(), pid: process.pid })); } finally { closeSync(fd); }
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  }
  release(key: string) { try { unlinkSync(join(this.directory, 'claims', `${digest(key)}.json`)); } catch { /* no claim */ } }
  recordRepair(value: unknown) { this.write(join(this.directory, 'repairs', `${Date.now()}-${randomUUID()}.json`), value); }
  serializeEvidence(evidence: ReturnType<QualityStore['evidence']>): string {
    // Keep cohorts and sample metadata while shrinking previews to fit a bounded Codex prompt.
    let text = JSON.stringify(evidence);
    while (text.length > 96_000) {
      const largest = [...evidence.representatives, ...evidence.counterexamples].sort((a, b) =>
        JSON.stringify(b.observations).length - JSON.stringify(a.observations).length)[0];
      if (!largest?.observations.length) break;
      largest.observations.shift(); largest.evidenceTruncated = true;
      text = JSON.stringify(evidence);
    }
    return text;
  }
  evidence(key: string, records = this.runs()) {
    const matching = records.filter(run => run.findings.some(finding => finding.key === key));
    const representatives = [...new Map(matching.map(run => [run.sessionId, run])).values()].slice(0, 3);
    const counterexamples = records.filter(run => run.outcome === 'completed' && !run.findings.some(finding => finding.key === key)).slice(0, 2);
    const sample = (run: QualityRun) => ({ ...run, observations: run.observations.slice(-30), findings: run.findings,
      evidenceTruncated: run.dropped > 0 || run.observations.length > 30 });
    return { hypothesis: key, summary: this.summarize(records), representatives: representatives.map(sample),
      counterexamples: counterexamples.map(sample), limitations: 'Bounded redacted observations; cohorts are observational, task mixes can differ. No automatic causality or resolved verdict.' };
  }
}

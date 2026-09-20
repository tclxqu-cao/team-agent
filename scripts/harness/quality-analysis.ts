import { createHash } from 'node:crypto';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
export interface Finding { key: string; kind: string; detail: string; severe: boolean }
export interface Observation { at: number; type: string; [key: string]: unknown }
export interface QualityRun {
  daemonPid?: number; id: string; sessionId: string; owner: string; startedAt: number; updatedAt: number;
  endedAt?: number; outcome: 'running' | 'completed' | 'error' | 'aborted' | 'interrupted';
  runtimeVersion: string; sourceVersion: string; model: string; task: string;
  observations: Observation[]; dropped: number; findings: Finding[];
  steps: number; iterations: number; compactions: number; peakContextRatio: number;
}
export function normalizeError(text: string): string {
  return text.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>').replace(/:\d+:\d+/g, ':line:column')
    .replace(/\b\d{3,}\b/g, '<n>').slice(0, 500);
}

const ENVIRONMENT_ERROR_CODES = new Set(['desktop_offline']);

/** Rules generate hypotheses, never correctness judgments. Only completed calls count as repeats. */
export function analyze(run: QualityRun): Finding[] {
  const findings = new Map<string, Finding>();
  const add = (kind: string, identity: string, detail: string, severe = false) => {
    const key = `${kind}:${digest(identity)}`; findings.set(key, { key, kind, detail, severe });
  };
  const calls = new Map<string, Observation>();
  const counts = new Map<string, number>();
  const completed: string[] = [];
  const beforeCompact = new Set<string>();
  let compacted = false;
  for (const event of run.observations) {
    if (event.type === 'tool_call') calls.set(String(event.callId), event);
    if (event.type === 'compacted') { compacted = true; for (const key of counts.keys()) beforeCompact.add(key); }
    if (event.type === 'tool_result') {
      const call = calls.get(String(event.callId)); if (!call) continue;
      const signature = digest([call.tool, call.argumentsHash, event.resultHash, event.isError]);
      const count = (counts.get(signature) ?? 0) + 1; counts.set(signature, count);
      completed.push(signature);
      if (count >= 3) add('repeated-tool', String(call.tool), `${call.tool}: identical arguments AND result observed ${count} times; verify whether polling/revalidation was necessary`);
      if (compacted && beforeCompact.has(signature)) add('reread-after-compaction', String(call.tool), `${call.tool}: same request and result before/after compaction; investigate lost context`);
      if (event.isError) add('tool-error', `${call.tool}:${normalizeError(String(event.preview))}`, `${call.tool}: ${String(event.preview).slice(0, 500)}`);
    }
    if (event.type === 'error' || event.type === 'fault') {
      const message = normalizeError(String(event.message ?? event.code ?? 'unknown'));
      const environmentError = event.type === 'error' && ENVIRONMENT_ERROR_CODES.has(String(event.code ?? ''));
      const kind = event.type === 'fault' ? 'exception' : environmentError ? 'environment-error' : 'agent-error';
      add(kind, String(event.code ?? '') + message, message, event.type === 'fault');
    }
    if (event.type === 'watchdog') add('no-progress', 'idle', 'No observable progress outside user waits', true);
    if (event.type === 'iteration_limit') add('iteration-limit', 'limit', 'Configured iteration budget exhausted; inspect exit conditions', true);
    if (event.type === 'request_context') {
      const sections = Object.values((event.systemSections ?? {}) as Record<string, { preview?: string }>);
      const previews = sections.map(section => section.preview).filter(value => value && value.length > 100);
      if (new Set(previews).size < previews.length) add('duplicate-context', 'sections', 'Identical long previews in different system sections; inspect full construction');
    }
  }
  for (const width of [2, 3, 4]) {
    for (let end = width * 3; end <= completed.length; end++) {
      const a = completed.slice(end - width * 3, end - width * 2).join();
      if (a === completed.slice(end - width * 2, end - width).join() && a === completed.slice(end - width, end).join()) {
        add('step-cycle', `width-${width}`, `A ${width}-step completed-call/result sequence repeated at least three times; suspected cycle`, true);
      }
    }
  }
  if (run.compactions >= 3) add('compaction-churn', 'churn', `${run.compactions} compactions during this run; inspect summary retention and input growth`);
  if (run.peakContextRatio >= 0.9) add('context-pressure', 'pressure', `Peak estimated context utilization ${Math.round(run.peakContextRatio * 100)}%; not by itself a defect`);
  return [...findings.values()];
}

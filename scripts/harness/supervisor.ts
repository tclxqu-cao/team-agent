import { mkdir, readFile, realpath, appendFile, writeFile } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { runCommand, type CommandResult } from './process.js';
import { readJson, writeJson, lockRun } from './state.js';
import { snapshotSource, forkVersion, linkDependencies, applyProposal, sealVersion,
  validateEditablePath, type RepairProposal } from './versions.js';
import { sandboxCommand, sourceDigest } from './verification.js';

export interface HarnessTask { input: string; sessionId: string; workingDirectory: string; maxIterations: number }
export interface HarnessConfig {
  sourceRoot: string;
  useAcceptedVersion?: boolean;
  stateDirectory: string;
  allowedFiles: string[];
  bunExecutable: string;
  nodeExecutable: string;
  maxRepairAttempts: number;
  runTimeoutMs: number;
  idleTimeoutMs: number;
  repairTimeoutMs: number;
  verificationTimeoutMs: number;
}
export interface Attempt { number: number; status: string; detail: string; version?: string }
export interface HarnessResult { status: 'completed' | 'blocked' | 'failed'; runDirectory: string; attempts: Attempt[]; detail: string }
export interface SupervisorDependencies {
  run: typeof runCommand;
  verify: typeof sandboxCommand;
}
export interface SupervisionContext {
  modelEnvironment?: NodeJS.ProcessEnv;
  externalFault?: { message: string };
  repairOnly?: boolean;
}
const defaults: SupervisorDependencies = { run: runCommand, verify: sandboxCommand };

export function validateConfig(config: HarnessConfig): void {
  if (!Array.isArray(config.allowedFiles) || !config.allowedFiles.length || config.allowedFiles.length > 12) {
    throw new Error('allowedFiles must contain 1–12 explicit core source paths');
  }
  for (const file of config.allowedFiles) validateEditablePath(file);
  for (const key of ['maxRepairAttempts', 'runTimeoutMs', 'idleTimeoutMs', 'repairTimeoutMs', 'verificationTimeoutMs'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid ${key}`);
  }
  if (config.maxRepairAttempts > 5) throw new Error('maxRepairAttempts must not exceed 5');
}

/** Single supervisor lock owns task state, active pointer and all version promotions. */
export async function supervise(config: HarnessConfig, task: HarnessTask, signal?: AbortSignal,
  dependencies: SupervisorDependencies = defaults, resume = false, context: SupervisionContext = {}): Promise<HarnessResult> {
  validateConfig(config);
  if (!task.input.trim() || !/^[a-zA-Z0-9-]+$/.test(task.sessionId) ||
      !Number.isSafeInteger(task.maxIterations) || task.maxIterations < 1) throw new Error('Invalid task');
  const source = await realpath(config.sourceRoot);
  const state = config.stateDirectory;
  if (!isAbsolute(state)) throw new Error('stateDirectory must be absolute');
  const stateRelative = relative(source, state);
  if (!stateRelative.startsWith('..') && !isAbsolute(stateRelative)) throw new Error('State must be outside the source checkout');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const release = await lockRun(state);
  const runDir = join(state, task.sessionId);
  const attempts: Attempt[] = [];
  let stable = '', stableCommit = '';
  const finish = async (status: HarnessResult['status'], detail: string): Promise<HarnessResult> => {
    const result = { status, detail, runDirectory: runDir, attempts };
    await writeJson(join(runDir, 'status.json'), result);
    return result;
  };
  try {
    // Never silently restart an existing task, overwrite a checkpoint, or erase an audit trail.
    if (!resume) await mkdir(runDir, { mode: 0o700 });
    const versions = join(runDir, 'versions');
    await mkdir(versions, { recursive: true });
    const taskFile = join(runDir, 'task.json');
    if (!resume) await writeJson(taskFile, task);
    stable = join(versions, 'baseline');
    if (resume) {
      const saved = await readJson<{ baselineCommit: string; source: string; allowedFiles: string[]; repairOnly?: boolean }>(join(runDir, 'policy.json'));
      if (saved.source !== source || JSON.stringify(saved.allowedFiles) !== JSON.stringify(config.allowedFiles)) throw new Error('Resume policy mismatch');
      if (saved.repairOnly) return await finish('blocked', 'Host repair candidates cannot replay the original Desktop/TUI task through the CLI');
      stableCommit = saved.baselineCommit;
      attempts.push(...await readJson<Attempt[]>(join(runDir, 'attempts.json')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }));
    } else {
      const accepted = config.useAcceptedVersion === false ? null : await readJson<{ source: string; root: string; commit: string; digest: string }>(join(state, 'accepted.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (accepted) {
        if (accepted.source !== source || accepted.digest !== await sourceDigest(accepted.root)) throw new Error('Accepted Harness source mismatch; inspect accepted.json or use --fresh-source');
        stableCommit = accepted.commit;
        await forkVersion(source, stableCommit, stable);
      } else stableCommit = await snapshotSource(source, stable);
      await linkDependencies(source, stable);
      await writeJson(join(runDir, 'policy.json'), { baselineCommit: stableCommit, source, allowedFiles: config.allowedFiles, repairOnly: Boolean(context.repairOnly) });
    }
    const pointer = join(runDir, 'active.json');
    if (!resume) await writeJson(pointer, { root: stable, commit: stableCommit, state: 'baseline' });
    const worker = join(stable, 'scripts/harness/worker.ts');
    const proposer = join(stable, 'scripts/harness/proposer.ts');
    const env = { ...process.env, ...context.modelEnvironment }; // Credentials inherited, never written to the task/config/log.
    let trace = '';
    const execute = async (root: string): Promise<CommandResult> => {
      trace = '';
      const result = await dependencies.run([config.bunExecutable, worker, root, taskFile, runDir], {
        cwd: task.workingDirectory, env, timeoutMs: config.runTimeoutMs, idleMs: config.idleTimeoutMs, signal,
        onLine: line => { trace = (trace + line + '\n').slice(-64_000); },
      });
      await appendFile(join(runDir, 'events.jsonl'), trace, { mode: 0o600 });
      if (result.code === 0) {
        const cp = await readJson<{ schema: number; phase: string; sessionId: string; input: string; finalText: string }>(join(runDir, 'checkpoint.json')).catch(() => null);
        const output = await readJson<{ finalText: string }>(join(runDir, 'result.json')).catch(() => null);
        if (!cp || cp.schema !== 1 || cp.phase !== 'completed' || cp.sessionId !== task.sessionId ||
            cp.input !== task.input || !output || output.finalText !== cp.finalText) {
          return { ...result, code: 1, output: result.output + '\nHarness exited without a durable completion receipt' };
        }
      }
      return result;
    };
    let initialRoot = stable;
    if (resume) {
      const active = await readJson<{ root: string; state: string; digest?: string }>(pointer);
      if (active.state === 'accepted' || active.state === 'verified') {
        if (!active.digest || active.digest !== await sourceDigest(active.root)) throw new Error('Resume candidate changed after verification');
        initialRoot = active.root;
      }
      const cp = await readJson<{ phase: string }>(join(runDir, 'checkpoint.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (cp?.phase === 'tools_pending') return await finish('blocked', 'Reconcile pending tool effects before resume');
    }
    const initialDigest = await sourceDigest(initialRoot);
    let failure = context.externalFault
      ? { code: 1, output: context.externalFault.message, timedOut: false }
      : await execute(initialRoot);
    if (initialDigest !== await sourceDigest(initialRoot)) return await finish('blocked', 'Harness source changed while running; recovery paused');
    if (failure.code === 0) {
      if (initialRoot !== stable) {
        const active = await readJson<{ commit: string }>(pointer);
        await writeJson(pointer, { root: initialRoot, commit: active.commit, digest: await sourceDigest(initialRoot), state: 'accepted' });
        await writeJson(join(state, 'accepted.json'), { source, root: initialRoot, commit: active.commit, digest: await sourceDigest(initialRoot) });
      }
      return await finish('completed', 'Harness task completed');
    }
    // Model/API errors, explicit cancellation and exhausted iteration budget are not proof of a code defect.
    if (failure.code === 2) return await finish('blocked', 'Task/model failure; no automatic Harness mutation');
    let lastFault = failure.output;
    for (let number = attempts.length + 1; number <= config.maxRepairAttempts; number++) {
      if (signal?.aborted) throw new Error('Supervisor cancelled');
      const attempt: Attempt = { number, status: 'running', detail: '' };
      attempts.push(attempt);
      await writeJson(join(runDir, 'attempts.json'), attempts);
      const dir = join(runDir, `repair-${number}`);
      await mkdir(dir, { mode: 0o700 });
      const candidate = join(versions, `candidate-${number}`);
      await forkVersion(source, stableCommit, candidate);
      await linkDependencies(source, candidate);
      const requestFile = join(dir, 'request.json');
      const proposalFile = join(dir, 'proposal.json');
      await writeJson(requestFile, {
        sourceRoot: stable, allowedFiles: config.allowedFiles,
        fault: { exitCode: failure.code, timedOut: failure.timedOut, evidence: lastFault.slice(-32_000) },
        priorAttempts: attempts,
      });
      const proposed = await dependencies.run([config.bunExecutable, proposer, requestFile, proposalFile], {
        cwd: stable, env, timeoutMs: config.repairTimeoutMs, signal,
      });
      if (proposed.code !== 0) {
        Object.assign(attempt, { status: 'proposer_failed', detail: proposed.output.slice(-4000) });
        await writeJson(join(runDir, 'attempts.json'), attempts);
        continue;
      }
      try {
        const proposal = await readJson<RepairProposal>(proposalFile);
        await applyProposal(candidate, config.allowedFiles, proposal);
        const before = await sourceDigest(candidate);
        const scratch = join(dir, 'verification');
        await mkdir(scratch);
        const reproduction = join(scratch, 'reproduction.ts');
        await writeFile(reproduction, proposal.reproduction, { mode: 0o600 });
        const testConfig = join(scratch, 'vitest.config.cjs');
        await writeFile(testConfig, 'module.exports = { test: { globals: true, environment: \"node\", include: [\"packages/**/*.test.ts\"] } };', { mode: 0o600 });
        const verificationEnv = {
          HARNESS_STABLE_ROOT: stable,
          HARNESS_DEPENDENCIES: await realpath(join(source, 'node_modules')),
          HARNESS_BUN_DIRECTORY: dirname(await realpath(config.bunExecutable)),
          HARNESS_NODE_DIRECTORY: dirname(await realpath(config.nodeExecutable)),
        };
        const verify = (command: string[], root: string) => dependencies.verify(command, root, scratch,
          { ...verificationEnv, HARNESS_CANDIDATE_ROOT: root }, config.verificationTimeoutMs, signal);
        // Fixed command and tests come from the baseline snapshot; source edits cannot touch tests.
        const regressionCommand = [config.nodeExecutable, join(stable, 'node_modules/vitest/vitest.mjs'),
          'run', '--config', testConfig, 'packages/core/src/domain/agent', 'packages/core/src/infrastructure/RunCheckpointStore.test.ts',
          '--pool=forks', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism', '--no-cache'];
        const oldRegression = await verify(regressionCommand, stable);
        if (oldRegression.code !== 0) throw new Error(`Baseline regressions fail; cannot assess candidate: ${oldRegression.output.slice(-6000)}`);
        const old = await verify([config.bunExecutable, reproduction], stable);
        if (old.code === 0) throw new Error('Reproducer does not fail on the old Harness');
        const repaired = await verify([config.bunExecutable, reproduction], candidate);
        if (repaired.code !== 0) throw new Error(`Candidate still fails reproduction: ${repaired.output.slice(-6000)}`);
        const regression = await verify(regressionCommand, candidate);
        await writeJson(join(dir, 'verification.json'), { oldRegression, old, repaired, regression });
        if (regression.code !== 0) throw new Error(`Candidate regression failed: ${regression.output.slice(-6000)}`);
        if (before !== await sourceDigest(candidate)) throw new Error('Candidate changed during verification');
        const commit = await sealVersion(candidate, config.allowedFiles);
        Object.assign(attempt, { status: 'verified', detail: proposal.reason, version: commit });
        await writeJson(join(runDir, 'attempts.json'), attempts);
        if (context.repairOnly) {
          await writeJson(pointer, { root: candidate, commit, digest: before, state: 'verified-host-candidate' });
          return await finish('blocked', 'Host Harness candidate verified; original host session was not replayed');
        }
        const cp = await readJson<{ phase: string }>(join(runDir, 'checkpoint.json')).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (cp?.phase === 'tools_pending') {
          await writeJson(pointer, { root: candidate, commit, digest: before, previous: stableCommit, state: 'verified' });
          return await finish('blocked', 'Candidate verified; pending tool effects need reconciliation before recovery');
        }
        await writeJson(pointer, { root: candidate, commit, digest: before, previous: stableCommit, state: 'probation' });
        failure = await execute(candidate);
        if (before !== await sourceDigest(candidate)) failure = { code: 1, timedOut: false, output: 'Candidate source changed during recovery' };
        if (failure.code === 0) {
          await writeJson(pointer, { root: candidate, commit, digest: before, previous: stableCommit, state: 'accepted' });
          await writeJson(join(state, 'accepted.json'), { source, root: candidate, commit, digest: await sourceDigest(candidate) });
          await writeJson(join(runDir, 'experience.json'), { sourceVersion: stableCommit, repairedVersion: commit,
            reason: proposal.reason, allowedFiles: config.allowedFiles, verification: join(dir, 'verification.json') });
          return await finish('completed', 'Candidate verified and original task completed');
        }
        // Roll back the version pointer; never roll back external effects or replay the old task blindly.
        await writeJson(pointer, { root: stable, commit: stableCommit, rejected: commit, state: 'rolled_back' });
        attempts.at(-1)!.status = 'rolled_back';
        lastFault = failure.output;
        return await finish('blocked', 'Candidate failed during recovery; version rolled back and task paused');
      } catch (error) {
        if (signal?.aborted) throw error;
        lastFault = `${failure.output}\nCandidate rejected: ${error instanceof Error ? error.message : String(error)}`;
        Object.assign(attempt, { status: 'rejected', detail: lastFault.slice(-6000) });
      }
      await writeJson(join(runDir, 'attempts.json'), attempts);
    }
    return await finish('failed', 'Repair budget exhausted; baseline retained');
  } catch (error) {
    // If a candidate was in probation, restore baseline even on persistence/spawn/cancellation failure.
    if (stableCommit) await writeJson(join(runDir, 'active.json'), { root: stable, commit: stableCommit, state: 'rolled_back' });
    throw error;
  } finally { await release(); }
}

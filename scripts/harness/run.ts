#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, access } from 'node:fs/promises';
import { supervise, type HarnessConfig, type HarnessTask } from './supervisor.js';
import { writeJson, readJson, lockRun } from './state.js';
import { FileRunCheckpointStore } from '../../packages/core/src/infrastructure/RunCheckpointStore.js';

const argv = process.argv.slice(2);
const value = (name: string) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const help = `Source Harness self-repair (macOS, Bun, Node 22)

bun scripts/harness/run.ts --init /absolute/path/harness.json
bun scripts/harness/run.ts --config /absolute/path/harness.json --task "Your task" --cwd /project
bun scripts/harness/run.ts --config /absolute/path/harness.json --resume RUN_ID
bun scripts/harness/run.ts --config /absolute/path/harness.json --reconcile RUN_ID --results /absolute/tool-results.json

Model environment: AGENT_PROVIDER (openai/anthropic/deepseek), AGENT_MODEL,
AGENT_API_KEY, optional AGENT_BASE_URL. No credentials are saved in config.
Reconcile results: [{"toolCallId":"...","content":"verified actual outcome","isError":false}]
Reconciliation records operator-verified outcomes for EVERY pending call; it never retries the calls.
Accepted versions are reused by later supervised tasks. --fresh-source starts from the current checkout.
No existing Desktop/Web/TUI process is replaced; no production publish.
`;

async function main() {
  if (!argv.length || argv.includes('--help')) { console.log(help); return; }
  const configFile = value('--config');
  const init = value('--init');
  if (init) {
    const node22 = join(homedir(), '.nvm/versions/node/v22.22.0/bin/node');
    await access(node22);
    const config: HarnessConfig = {
      sourceRoot, stateDirectory: join(homedir(), '.customer-agent-harness'),
      allowedFiles: ['packages/core/src/domain/agent/AgentLoop.ts', 'packages/core/src/domain/agent/ContextCompactor.ts'],
      bunExecutable: process.execPath, nodeExecutable: node22, maxRepairAttempts: 2,
      runTimeoutMs: 1_800_000, idleTimeoutMs: 180_000, repairTimeoutMs: 300_000, verificationTimeoutMs: 120_000,
    };
    // Initialization must not overwrite an existing local policy.
    await import('node:fs/promises').then(fs => fs.writeFile(resolve(init), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 }));
    console.log(`Config: ${resolve(init)}`);
    return;
  }
  if (!configFile) throw new Error('--config is required');
  const config = await readJson<HarnessConfig>(resolve(configFile));
  if (argv.includes('--fresh-source')) config.useAcceptedVersion = false;
  const reconcile = value('--reconcile');
  if (reconcile) {
    if (!/^[a-zA-Z0-9-]+$/.test(reconcile) || !value('--results')) throw new Error('Invalid reconciliation arguments');
    const release = await lockRun(config.stateDirectory);
    try {
      const store = new FileRunCheckpointStore(join(config.stateDirectory, reconcile, 'checkpoint.json'));
      const cp = await store.load();
      if (cp?.phase !== 'tools_pending') throw new Error('No pending tool batch');
      const results = JSON.parse(await readFile(resolve(value('--results')!), 'utf8'));
      if (!Array.isArray(results) || results.length !== cp.pendingToolIds.length ||
          new Set(results.map(r => r.toolCallId)).size !== results.length ||
          results.some(r => !cp.pendingToolIds.includes(r.toolCallId) || typeof r.content !== 'string')) {
        throw new Error('Supply exactly one verified result for every pending tool call');
      }
      for (const id of cp.pendingToolIds) {
        const result = results.find(r => r.toolCallId === id);
        cp.messages.push({ role: 'tool', toolCallId: id, content: result.isError ? `Error: ${result.content}` : result.content });
      }
      cp.phase = 'ready'; cp.pendingToolIds = [];
      await writeJson(join(config.stateDirectory, reconcile, `reconciliation-${Date.now()}.json`), results);
      await store.save(cp);
      console.log('Verified tool outcomes saved. Use --resume to continue.');
    } finally { await release(); }
    return;
  }
  if (!process.env.AGENT_API_KEY || !process.env.AGENT_MODEL) throw new Error('Set AGENT_API_KEY and AGENT_MODEL');
  const resume = value('--resume');
  if (resume && !/^[a-zA-Z0-9-]+$/.test(resume)) throw new Error('Invalid run id');
  const task: HarnessTask = resume
    ? await readJson(join(config.stateDirectory, resume, 'task.json'))
    : { input: value('--task') || '', sessionId: randomUUID(), workingDirectory: resolve(value('--cwd') || process.cwd()), maxIterations: 30 };
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    console.log(`Harness run: ${task.sessionId}\nState: ${join(config.stateDirectory, task.sessionId)}`);
    const result = await supervise(config, task, abort.signal, undefined, Boolean(resume));
    console.log(`${result.status}: ${result.detail}`);
    if (result.status === 'completed') {
      const output = await readJson<{ finalText: string }>(join(result.runDirectory, 'result.json'));
      console.log(output.finalText);
    } else process.exitCode = 1;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

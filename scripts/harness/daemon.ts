import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { HarnessCompanion, type CompanionStatus } from './daemon-service.js';
import { QualityStore } from './quality-store.js';
import { digest } from './quality-analysis.js';
import { writeJson } from './state.js';

const [sourceRoot, stateRoot, owner, nodeExecutable] = process.argv.slice(2);
if (!sourceRoot || !stateRoot || !['desktop', 'server', 'tui'].includes(owner) || !nodeExecutable) process.exit(2);
const stateFile = join(stateRoot, 'services', `${owner}-${process.env.HARNESS_PARENT_PID || process.ppid}.json`);
await mkdir(join(stateRoot, 'services'), { recursive: true, mode: 0o700 });
let persistence = Promise.resolve();
const publish = (status: CompanionStatus) => {
  const record = { type: 'status', ...status, pid: process.pid, parentPid: process.ppid, owner, updated: new Date().toISOString() };
  process.stdout.write(JSON.stringify(record) + '\n');
  persistence = persistence.then(() => writeJson(stateFile, record)).catch(() => {});
};
const companion = new HarnessCompanion({
  sourceRoot, stateDirectory: join(stateRoot, 'host-repairs', `${owner}-${process.env.HARNESS_PARENT_PID || process.ppid}`),
  useAcceptedVersion: false,
  allowedFiles: ['packages/core/src/domain/agent/AgentLoop.ts', 'packages/core/src/domain/agent/ContextCompactor.ts'],
  bunExecutable: process.execPath, nodeExecutable, maxRepairAttempts: 2,
  runTimeoutMs: 1_800_000, idleTimeoutMs: 180_000, repairTimeoutMs: 300_000, verificationTimeoutMs: 120_000,
}, publish, undefined, new QualityStore(join(stateRoot, 'quality', digest(sourceRoot))));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closing = false;
const timer = setInterval(() => companion.tick(), 1000);
async function close() {
  if (closing) return; closing = true;
  clearInterval(timer); input.close(); process.stdin.pause();
  await companion.close(); await persistence;
}
input.on('line', line => {
  if (line.length > 256_000) return;
  try {
    const message = JSON.parse(line);
    if (message.type === 'shutdown') void close(); else companion.receive(message);
  } catch { publish({ state: 'ready', detail: 'A diagnostic record could not be processed; inspect local storage availability' }); }
});
input.on('close', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });

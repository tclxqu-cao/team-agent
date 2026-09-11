import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { runCommand } from './process.js';
import { supervise, type HarnessConfig } from './supervisor.js';
import { readJson } from './state.js';

const repo = process.cwd();
const roots: string[] = [];
const servers: Server[] = [];
const originalEnv = { ...process.env };
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const key of ['AGENT_API_KEY', 'AGENT_MODEL', 'AGENT_PROVIDER', 'AGENT_BASE_URL']) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-integration-')); roots.push(root);
  const source = join(root, 'source');
  await mkdir(join(source, 'packages/core'), { recursive: true });
  await mkdir(join(source, 'scripts'), { recursive: true });
  await cp(join(repo, 'packages/core/src'), join(source, 'packages/core/src'), { recursive: true });
  await cp(join(repo, 'scripts/harness'), join(source, 'scripts/harness'), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json', 'vitest.config.ts', '.gitignore', 'packages/core/package.json', 'packages/core/tsconfig.json']) {
    await cp(join(repo, file), join(source, file));
  }
  await symlink(join(repo, 'node_modules'), join(source, 'node_modules'), 'dir');
  await symlink(join(repo, 'packages/core/node_modules'), join(source, 'packages/core/node_modules'), 'dir');
  const fault = '    if (input === "harness fault injection") throw new Error("HARNESS_FIXTURE_FAILURE");\n';
  const agentFile = 'packages/core/src/domain/agent/AgentLoop.ts';
  const sourceText = await readFile(join(source, agentFile), 'utf8');
  await writeFile(join(source, agentFile), sourceText.replace('    // 1. Load session history', fault + '    // 1. Load session history'));
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'fixture']]) {
    const result = await runCommand(['git', ...args], { cwd: source, timeoutMs: 10_000 });
    if (result.code) throw new Error(result.output);
  }
  const config: HarnessConfig = {
    sourceRoot: source, stateDirectory: join(root, 'state'), allowedFiles: [agentFile],
    bunExecutable: join(homedir(), '.bun/bin/bun'), nodeExecutable: join(homedir(), '.nvm/versions/node/v22.22.0/bin/node'),
    maxRepairAttempts: 1, runTimeoutMs: 10_000, idleTimeoutMs: 5000, repairTimeoutMs: 10_000, verificationTimeoutMs: 30_000,
  };
  const task = { input: 'harness fault injection', sessionId: 'integration', workingDirectory: root, maxIterations: 5 };
  return { config, task, root, fault, agentFile };
}

const reproduction = `
import assert from 'node:assert/strict';
const {AgentBuilder} = await import(process.env.HARNESS_CANDIDATE_ROOT + '/packages/core/src/domain/agent/AgentBuilder.ts');
const provider = {providerId:'mock',modelId:'mock',countTokens:async()=>10,supportsModel:()=>true,
 streamChat:async function*(){yield {type:'text_chunk',text:'ok'};yield {type:'text_done'};}};
const agent = await new AgentBuilder().withWorkingDirectory(process.env.TMPDIR).withSemanticSkillMatching(false).withModelProvider(provider).build();
let text='';
for await(const event of agent.run('harness fault injection','test')) if(event.type==='done')text=event.finalText;
assert.equal(text,'ok');
`;

async function modelServer(proposal: unknown, failRecovery = false) {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const payload = JSON.parse(body);
    const isRepair = payload.messages?.[0]?.content?.includes('You repair the Agent Harness');
    if (!isRepair && failRecovery) { res.writeHead(500); res.end('fixture upstream error'); return; }
    const content = isRepair ? JSON.stringify(proposal) : 'task recovered';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  Object.assign(process.env, { AGENT_API_KEY: 'test-only', AGENT_MODEL: 'fixture', AGENT_PROVIDER: 'openai', AGENT_BASE_URL: `http://127.0.0.1:${address.port}/v1` });
}

describe('Harness supervised self-repair', () => {
  it.skipIf(process.platform !== 'darwin')('repairs a real source fault through a separate model process, sandbox validation and new worker', async () => {
    const { config, task, fault, agentFile } = await fixture();
    await modelServer({ reason: 'Remove injected Harness failure', edits: [{ path: agentFile, before: fault, after: '' }], reproduction });
    const result = await supervise(config, task);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed' });
    const active = await readJson<{ state: string }>(join(result.runDirectory, 'active.json'));
    expect(active.state).toBe('accepted');
    expect(await readJson(join(result.runDirectory, 'result.json'))).toEqual({ finalText: 'task recovered' });
    expect(await readFile(join(config.sourceRoot, agentFile), 'utf8')).toContain(fault);
    const next = await supervise(config, { ...task, sessionId: 'next-task' });
    expect(next.status).toBe('completed');
    expect(next.attempts).toHaveLength(0); // Subsequent tasks use the accepted Harness.
    const resumed = await supervise(config, { ...task, sessionId: 'next-task' }, undefined, undefined, true);
    expect(resumed.status).toBe('completed');
  }, 90_000);

  it('rejects a candidate whose claimed reproducer passes on the old version', async () => {
    const { config, task, fault, agentFile } = await fixture();
    await modelServer({ reason: 'fix', edits: [{ path: agentFile, before: fault, after: '' }], reproduction: 'process.exit(0)' });
    const result = await supervise(config, task, undefined, {
      run: runCommand,
      verify: async () => ({ code: 0, output: '', timedOut: false }),
    });
    expect(result.status).toBe('failed');
    expect(result.attempts[0].detail).toContain('does not fail');
    expect((await readJson<{ state: string }>(join(result.runDirectory, 'active.json'))).state).toBe('baseline');
  }, 30_000);

  it('repairs external host evidence without ever replaying its business task', async () => {
    const { config, task, fault, agentFile } = await fixture();
    await modelServer({ reason: 'fix', edits: [{ path: agentFile, before: fault, after: '' }], reproduction });
    let checks = 0, workerRuns = 0;
    const result = await supervise(config, task, undefined, {
      run: async (command, options) => {
        if (command[1].endsWith('/worker.ts')) workerRuns++;
        return runCommand(command, options);
      },
      verify: async () => ({ code: ++checks === 2 ? 1 : 0, output: '', timedOut: false }),
    }, false, { externalFault: { message: 'Host Harness failure' }, repairOnly: true });
    expect(workerRuns).toBe(0);
    expect(result.detail).toContain('Host Harness candidate verified');
    const resumed = await supervise(config, task, undefined, undefined, true);
    expect(resumed.detail).toContain('cannot replay');
  }, 30_000);

  it('keeps a verified candidate paused while tool effects are unresolved', async () => {
    const { config, task, fault, agentFile } = await fixture();
    await modelServer({ reason: 'fix', edits: [{ path: agentFile, before: fault, after: '' }], reproduction });
    let checks = 0, workerRuns = 0;
    const result = await supervise(config, task, undefined, {
      run: async (command, options) => {
        const output = await runCommand(command, options);
        if (command[1].endsWith('/worker.ts')) {
          workerRuns++;
          await writeFile(join(config.stateDirectory, task.sessionId, 'checkpoint.json'), JSON.stringify({ phase: 'tools_pending' }));
        }
        return output;
      },
      verify: async () => ({ code: ++checks === 2 ? 1 : 0, output: '', timedOut: false }),
    });
    expect(result.status).toBe('blocked');
    expect(result.detail).toContain('pending tool effects');
    expect(workerRuns).toBe(1);
    expect((await readJson<{ state: string }>(join(result.runDirectory, 'active.json'))).state).toBe('verified');
  }, 30_000);

  it('rejects a regression even when the proposed reproduction passes', async () => {
    const { config, task, fault, agentFile } = await fixture();
    await modelServer({ reason: 'fix', edits: [{ path: agentFile, before: fault, after: '' }], reproduction });
    let checks = 0;
    const result = await supervise(config, task, undefined, {
      run: runCommand,
      verify: async () => ({ code: [0, 1, 0, 1][checks++], output: 'fixed regression evidence', timedOut: false }),
    });
    expect(result.status).toBe('failed');
    expect(result.attempts[0].detail).toContain('Candidate regression failed');
  }, 30_000);

  it('rolls back the active version if recovery fails after successful verification', async () => {
    const { config, task, fault, agentFile } = await fixture();
    await modelServer({ reason: 'fix', edits: [{ path: agentFile, before: fault, after: '' }], reproduction }, true);
    let call = 0;
    const result = await supervise(config, task, undefined, {
      run: runCommand,
      verify: async () => ({ code: ++call === 2 ? 1 : 0, output: '', timedOut: false }),
    });
    expect(result.status).toBe('blocked');
    expect((await readJson<{ state: string }>(join(result.runDirectory, 'active.json'))).state).toBe('rolled_back');
  }, 30_000);
});

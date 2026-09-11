import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { diagnosticValue, diagnosticHash, redactDiagnostic } from './HarnessObservation.js';
import type { AgentEvent } from '../domain/agent/entities.js';

export interface HarnessModelSettings { provider: string; modelId: string; apiKey: string; baseUrl?: string }
export interface HarnessServiceStatus {
  state: 'starting' | 'waiting-model' | 'ready' | 'repairing' | 'stopped' | 'unavailable';
  pid?: number;
  modelId?: string;
  detail?: string;
  quality?: unknown;
}
export interface HarnessServiceOptions {
  owner: 'desktop' | 'server' | 'tui';
  sourceRoot?: string;
  stateDirectory?: string;
  bunExecutable?: string;
  nodeExecutable?: string;
  enabled?: boolean;
}

async function executable(candidates: Array<string | undefined>): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
}

async function sourceRoot(explicit?: string): Promise<string | undefined> {
  const starts = [explicit, process.cwd()];
  try { starts.push(dirname(fileURLToPath(import.meta.url))); } catch { /* bundled host */ }
  for (const start of starts) {
    if (!start) continue;
    let dir = start;
    for (let depth = 0; depth < 8; depth++) {
      try { await access(join(dir, 'scripts/harness/daemon.ts')); return dir; } catch { /* parent */ }
      const parent = dirname(dir); if (parent === dir) break; dir = parent;
    }
  }
}

/** Source-mode companion: no model request on boot; secrets travel only over the private pipe. */
export class HarnessServiceClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
  private model: HarnessModelSettings | null = null;
  private current: HarnessServiceStatus = { state: 'stopped' };
  private restartCount = 0;
  private runtimeVersion = 'unknown';
  private readonly onExit = () => { this.child?.stdin.end(); this.child?.kill('SIGTERM'); };

  constructor(private readonly options: HarnessServiceOptions) {}
  get status(): HarnessServiceStatus { return { ...this.current }; }

  setModel(model: HarnessModelSettings): void {
    // Kept for host API compatibility. Codex owns repair authentication and model selection.
    void model;
  }

  start(): Promise<void> {
    if (this.closed || this.child) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.launch().catch(() => {
      this.current = { state: 'unavailable', detail: 'Companion launch failed' };
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async launch(): Promise<void> {
    if (this.options.enabled === false || (this.options.enabled !== true &&
        (process.env.VITEST || process.env.AGENT_HARNESS_AUTOSTART === '0'))) return;
    this.current = { state: 'starting' };
    const root = await sourceRoot(this.options.sourceRoot);
    const bun = await executable([this.options.bunExecutable, process.env.HARNESS_BUN_BINARY, join(homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun']);
    const node = await executable([this.options.nodeExecutable, process.env.HARNESS_NODE_BINARY,
      join(homedir(), '.nvm/versions/node/v22.22.0/bin/node'), '/opt/homebrew/opt/node@22/bin/node']);
    if (!root || !bun || !node || process.platform !== 'darwin') {
      this.current = { state: 'unavailable', detail: 'Requires a source checkout, Bun, Node 22 and macOS' };
      return;
    }
    if (this.closed) return;
    if (this.runtimeVersion === 'unknown') {
      try { this.runtimeVersion = diagnosticHash(await readFile(fileURLToPath(import.meta.url), 'utf8')); } catch { /* unknown bundle */ }
    }
    const state = this.options.stateDirectory ?? join(homedir(), '.customer-agent-harness');
    const child = spawn(bun, [join(root, 'scripts/harness/daemon.ts'), root, state, this.options.owner, node], {
      cwd: root, env: { ...process.env, HARNESS_PARENT_PID: String(process.pid) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    process.removeListener('exit', this.onExit); process.once('exit', this.onExit);
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-256_000);
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'status') {
            this.current = { state: message.state, pid: child.pid, modelId: message.modelId, detail: message.detail, quality: message.quality };
            console.info(`[harness] ${this.options.owner}: ${message.state} (pid ${child.pid})`);
          }
        } catch { /* protocol ignores non-JSON dependency diagnostics */ }
      }
    });
    // Never relay child stderr: upstream exceptions can contain credential-bearing URLs.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.once('error', () => { this.current = { state: 'unavailable', detail: 'Companion launch failed' }; });
    child.once('close', () => {
      if (this.child === child) this.child = null;
      this.current = { state: this.closed ? 'stopped' : 'unavailable', detail: this.closed ? undefined : 'Companion exited' };
      if (!this.closed && this.restartCount++ < 2) {
        const timer = setTimeout(() => { void this.start(); }, 1000); timer.unref();
      }
    });
    if (this.model) this.send({ type: 'configure', model: this.model });
  }

  private send(message: unknown): void {
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  observe(sessionId: string, observation: unknown): void {
    try { this.send({ type: 'observation', sessionId, data: diagnosticValue(observation) }); } catch { /* noncritical */ }
  }

  async *monitor(events: AsyncIterable<AgentEvent>, task: { input: string; sessionId: string; workingDirectory: string }): AsyncIterable<AgentEvent> {
    await this.start();
    const id = randomUUID();
    this.send({ type: 'begin', id, ...task, input: redactDiagnostic(task.input).slice(0, 8000),
      runtimeVersion: this.runtimeVersion, owner: this.options.owner });
    let lastSent = 0;
    try {
      for await (const event of events) {
        // Keep full business events in the existing host store; only compact diagnostics go to the companion.
        if (event.type !== 'text_chunk' || Date.now() - lastSent > 1000) {
          const wait = event.type === 'ask_user' || (event.type === 'tool_call' && event.toolCall.name === 'ask_user');
          let data: unknown = { type: event.type };
          if (event.type === 'tool_call') data = { type: event.type, tool: event.toolCall.name, callId: event.toolCall.id,
            argumentsHash: diagnosticHash(event.toolCall.arguments), arguments: diagnosticValue(event.toolCall.arguments) };
          else if (event.type === 'tool_result') data = { type: event.type, callId: event.result.toolCallId,
            resultHash: diagnosticHash(event.result.content), isError: event.result.isError,
            preview: redactDiagnostic(event.result.content).slice(0, 1200) };
          else if (['context_usage', 'compacted', 'error', 'done', 'turn_aborted'].includes(event.type)) data = diagnosticValue(event);
          this.send({ type: 'progress', id, eventType: event.type, waiting: wait, data,
            tool: event.type === 'tool_call' ? event.toolCall.name : undefined });
          lastSent = Date.now();
        }
        yield event;
      }
    } catch (error) {
      this.send({ type: 'fault', id, message: redactDiagnostic(error instanceof Error ? error.stack ?? error.message : String(error)) });
      throw error;
    } finally { this.send({ type: 'end', id }); }
  }

  async withUserWait<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    this.send({ type: 'waiting', sessionId, waiting: true });
    try { return await action(); }
    finally { this.send({ type: 'waiting', sessionId, waiting: false }); }
  }

  close(): void {
    this.closed = true;
    process.removeListener('exit', this.onExit);
    this.send({ type: 'shutdown' });
    const child = this.child;
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 3000);
      timer.unref(); child.once('exit', () => clearTimeout(timer));
    }
    this.current = { state: 'stopped' };
  }
}

import { spawn } from 'node:child_process';

export interface CommandResult { code: number; output: string; timedOut: boolean }
export interface CommandOptions {
  cwd: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  idleMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

/** The supervisor never imports replaceable Harness code. Kill the complete child group. */
export function runCommand(command: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('Supervisor cancelled'));
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd, env: options.env ?? process.env,
      detached: process.platform !== 'win32', stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input);
    let output = '', lines = '', timedOut = false, stopped = false;
    let lastActivity = Date.now();
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { kill('SIGTERM'); } catch (error) { cleanup(); reject(error); return; }
      killTimer = setTimeout(() => {
        try { kill('SIGKILL'); } catch (error) { cleanup(); reject(error); }
      }, 500);
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const idle = setInterval(() => {
      if (options.idleMs && Date.now() - lastActivity > options.idleMs) { timedOut = true; stop(); }
    }, Math.min(1000, options.idleMs ?? 1000));
    const receive = (data: Buffer, stdout: boolean) => {
      output = (output + data.toString()).slice(-128_000);
      if (!stdout) return;
      lastActivity = Date.now();
      lines = (lines + data.toString()).slice(-256_000);
      let end: number;
      while ((end = lines.indexOf('\n')) >= 0) {
        options.onLine?.(lines.slice(0, end));
        lines = lines.slice(end + 1);
      }
    };
    child.stdout!.on('data', data => receive(data, true));
    child.stderr!.on('data', data => receive(data, false));
    options.signal?.addEventListener('abort', stop, { once: true });
    const cleanup = () => {
      clearTimeout(timeout); clearInterval(idle); clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', stop);
      // Descendants can survive a parent exit and keep stdout open.
      try { kill('SIGKILL'); } catch (error) {
        // macOS may return EPERM for a group containing only already-exited sandbox children.
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') reject(error);
      }
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', cleanup);
    child.once('close', code => {
      if (options.signal?.aborted) reject(new Error('Supervisor cancelled'));
      else resolve({ code: timedOut ? 124 : (code ?? 1), output, timedOut });
    });
  });
}

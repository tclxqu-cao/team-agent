import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type CodexAppServerLaunchMode = "shared" | "standalone";

export interface CodexAppServerLaunchAttempt {
  readonly mode: CodexAppServerLaunchMode;
  launch(): Promise<ChildProcessWithoutNullStreams>;
}

export interface CodexAppServerLauncher {
  attempts(): readonly CodexAppServerLaunchAttempt[];
}

export interface CodexAppServerLauncherOptions {
  executable: string;
  environment: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
  startupTimeoutMs?: number;
}

const DEFAULT_DAEMON_START_TIMEOUT_MS = 10_000;
const MAX_STDERR_LENGTH = 4_096;

export class SharedCodexAppServerLauncher implements CodexAppServerLaunchAttempt {
  readonly mode = "shared" as const;
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnProcess: typeof spawn;
  private readonly startupTimeoutMs: number;

  constructor(options: CodexAppServerLauncherOptions) {
    this.executable = options.executable;
    this.environment = options.environment;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_DAEMON_START_TIMEOUT_MS;
  }

  async launch(): Promise<ChildProcessWithoutNullStreams> {
    await runCommandToCompletion({
      executable: this.executable,
      args: ["app-server", "daemon", "start"],
      environment: this.environment,
      spawnProcess: this.spawnProcess,
      timeoutMs: this.startupTimeoutMs,
    });
    return spawnLongRunningProcess(
      this.spawnProcess,
      this.executable,
      ["app-server", "proxy"],
      this.environment,
    );
  }
}

export class StandaloneCodexAppServerLauncher implements CodexAppServerLaunchAttempt {
  readonly mode = "standalone" as const;
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnProcess: typeof spawn;

  constructor(options: CodexAppServerLauncherOptions) {
    this.executable = options.executable;
    this.environment = options.environment;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async launch(): Promise<ChildProcessWithoutNullStreams> {
    return spawnLongRunningProcess(
      this.spawnProcess,
      this.executable,
      ["app-server", "--stdio"],
      this.environment,
    );
  }
}

export class FallbackCodexAppServerLauncher implements CodexAppServerLauncher {
  constructor(
    private readonly shared: CodexAppServerLaunchAttempt,
    private readonly standalone: CodexAppServerLaunchAttempt,
  ) {}

  attempts(): readonly CodexAppServerLaunchAttempt[] {
    return [this.shared, this.standalone];
  }
}

function spawnWithPipedStdio(
  spawnProcess: typeof spawn,
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return spawnProcess(executable, args, {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

function spawnLongRunningProcess(
  spawnProcess: typeof spawn,
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawnWithPipedStdio(spawnProcess, executable, args, environment);
  return new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve(child);
    };
    const onSpawn = () => {
      finish();
    };
    const onError = (error: Error) => {
      finish(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const status = code === null ? signal ?? "unknown" : String(code);
      finish(new Error(`Codex app-server process exited before startup (${status})`));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
    if (typeof child.pid === "number") queueMicrotask(onSpawn);
  });
}

async function runCommandToCompletion(options: {
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  spawnProcess: typeof spawn;
  timeoutMs: number;
}): Promise<void> {
  const child = spawnWithPipedStdio(
    options.spawnProcess,
    options.executable,
    options.args,
    options.environment,
  );
  child.stdin.end();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Codex app-server daemon start timed out after ${options.timeoutMs}ms`));
    }, Math.max(1, options.timeoutMs));

    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_LENGTH);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim();
      const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      finish(new Error(
        `Codex app-server daemon start exited with ${status}${detail ? `: ${detail}` : ""}`,
      ));
    });
  });
}

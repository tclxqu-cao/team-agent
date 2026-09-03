import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

type SpawnProcess = typeof spawn;

export class ProcessSupervisor {
  private children = new Set<ChildProcess>();

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly spawnProcess: SpawnProcess = spawn,
    private readonly killProcess: typeof process.kill = process.kill.bind(process),
  ) {}

  spawn(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
    const child = this.spawnProcess(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: this.platform !== "win32",
      ...options,
    });
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    return child;
  }

  async stopAll(timeoutMs = 5000): Promise<void> {
    await Promise.all([...this.children].map((child) => this.stop(child, timeoutMs)));
  }

  async stop(child: ChildProcess, timeoutMs = 5000): Promise<void> {
    if (child.exitCode !== null || !child.pid) return;
    const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    await this.terminate(child, "SIGTERM");
    await Promise.race([exited, delay(timeoutMs)]);
    if (child.exitCode === null) await this.terminate(child, "SIGKILL");
  }

  private async terminate(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
    if (this.platform === "win32") {
      if (!(await runTaskkill(this.spawnProcess, child.pid!))) child.kill(signal);
      return;
    }
    try {
      this.killProcess(-child.pid!, signal);
    } catch {
      child.kill(signal);
    }
  }
}

function runTaskkill(spawnProcess: SpawnProcess, pid: number): Promise<boolean> {
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    try {
      const killer = spawnProcess("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", () => finish(false));
      killer.once("exit", (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}

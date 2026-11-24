import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readTailscaleStatus, type TailscaleCommandOptions, type TailscaleStatus } from "./tailnet-cli.js";

export interface TailscaleDaemonOptions {
  /** 实例数据目录（<dataDir>）；socket 与 statedir 固定在 <dataDir>/tailscale 下。 */
  dataDir: string;
  tailscaledPath: string;
  /** 探活/命令复用同一 socket；tailscale CLI 的 --socket 必须与守护进程一致。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnImpl?: typeof spawn;
  onLog?: (line: string) => void;
}

export interface TailscaleRuntime {
  socketPath: string;
  stateDir: string;
  /** true = 复用了已在运行的守护进程；false = 本次新拉起。 */
  reused: boolean;
  status: TailscaleStatus;
}

/**
 * tailscaled（userspace 模式）生命周期管理。
 *
 * 复用优先：socket 上已有可用的 tailscaled（例如同机另一个 agentroam 进程已拉起）时
 * 直接复用，绝不启动第二个守护进程争抢 statedir。userspace 模式不需要 root/TUN。
 */
export class TailscaleDaemon {
  private child: ChildProcess | null = null;

  constructor(private readonly options: TailscaleDaemonOptions) {}

  socketPath(): string {
    if (process.platform === "win32") {
      const id = createHash("sha256").update(this.stateDir().toLowerCase()).digest("hex").slice(0, 24);
      return `\\\\.\\pipe\\agentroam-tailscale-${id}`;
    }
    return resolve(this.stateDir(), "tailscaled.sock");
  }

  stateDir(): string {
    return resolve(this.options.dataDir, "tailscale");
  }

  /** tailscale CLI 与 tailscaled 同目录、同名去 d（PATH 探测来源同样是成对相邻的）。 */
  cliPath(): string {
    return this.options.tailscaledPath.replace(/tailscaled(\.exe)?$/, "tailscale$1");
  }

  private cliOptionsWith(tailscalePath: string): TailscaleCommandOptions {
    return {
      tailscalePath,
      socketPath: this.socketPath(),
      timeoutMs: this.options.timeoutMs,
      spawnImpl: this.options.spawnImpl,
      signal: this.options.signal,
    };
  }

  /** 用给定 tailscale CLI 探活；BackendState=Unknown 且无 100.x 视为未就绪。 */
  private async probeStatus(cliPath: string): Promise<TailscaleStatus | null> {
    try {
      const status = await readTailscaleStatus(this.cliOptionsWith(cliPath));
      if (["Unknown", "NoState", "Starting"].includes(status.backendState)) return null;
      return status;
    } catch {
      return null;
    }
  }

  async ensureRunning(tailscalePath: string): Promise<TailscaleRuntime> {
    const socketPath = this.socketPath();
    const stateDir = this.stateDir();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(stateDir, 0o700);

    const existing = await this.probeStatus(tailscalePath);
    if (existing) return { socketPath, stateDir, reused: true, status: existing };

    if (this.child) await this.stopChild();
    const log = this.options.onLog ?? (() => {});
    log("Starting tailscaled (userspace)…");
    const spawnImpl = this.options.spawnImpl ?? spawn;
    let startupError: Error | undefined;
    const child = spawnImpl(this.options.tailscaledPath, [
      "--tun=userspace-networking", "--port=0",
      ...(process.platform === "win32" ? ["--windows-mode=dev"] : []),
      `--statedir=${stateDir}`,
      `--socket=${socketPath}`,
    ], {
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      env: { ...process.env, AGENT_HEADSCALE_API_KEY: undefined },
    });
    this.child = child;
    child.stderr?.on("data", (chunk) => log(String(chunk).trimEnd()));
    child.once("error", error => { startupError = error; });
    child.once("exit", () => { if (this.child === child) this.child = null; });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      this.options.signal?.throwIfAborted();
      if (startupError) throw startupError;
      if (this.child === null) throw new Error("tailscaled exited during startup");
      const status = await this.probeStatus(tailscalePath);
      if (status) return { socketPath, stateDir, reused: false, status };
      await delay(300, undefined, { signal: this.options.signal });
    }
    await this.stopChild();
    throw new Error("tailscaled did not become ready within 15s (check tailscaled availability and statedir permissions)");
  }

  async stop(): Promise<void> {
    await this.stopChild();
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolveExit) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolveExit(null); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolveExit(null); });
      child.kill("SIGTERM");
    });
  }
}

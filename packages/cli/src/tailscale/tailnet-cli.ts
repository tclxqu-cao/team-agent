import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * tailscale CLI 封装：所有调用都显式指向本实例的 tailscaled socket，
 * 不依赖全局默认 socket（避免与系统安装的 Tailscale 互相干扰）。
 */
export interface TailscaleCommandOptions {
  tailscalePath: string;
  socketPath: string;
  timeoutMs?: number;
  /** 运行测试或特殊环境时注入 spawn；默认真实子进程。 */
  spawnImpl?: typeof spawn;
  signal?: AbortSignal;
}

export interface TailscaleCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class TailscaleCommandError extends Error {
  constructor(message: string, readonly result: TailscaleCommandResult) {
    super(message);
  }
}

export async function runTailscaleCommand(options: TailscaleCommandOptions, args: string[]): Promise<TailscaleCommandResult> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const spawnImpl = options.spawnImpl ?? spawn;
  return await new Promise<TailscaleCommandResult>((resolveCommand, rejectCommand) => {
    const child = spawnImpl(options.tailscalePath, ["--socket", options.socketPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectCommand(new TailscaleCommandError(`tailscale ${args[0]} timed out after ${timeoutMs}ms`, { stdout, stderr, code: -1 }));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); rejectCommand(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const result: TailscaleCommandResult = { stdout, stderr, code: code ?? -1 };
      if (code === 0) resolveCommand(result);
      else rejectCommand(new TailscaleCommandError(`tailscale ${args[0]} exited ${code}: ${stderr.trim() || stdout.trim().slice(0, 400)}`, result));
    });
  });
}

export interface TailscaleStatus {
  backendState: string;
  tailscaleIPs: string[];
  dnsName: string | null;
  hostname: string | null;
  controlPlaneUrl: string | null;
}

interface StatusJson {
  BackendState?: unknown;
  Self?: {
    DNSName?: unknown;
    TailscaleIPs?: unknown;
    HostName?: unknown;
  } | null;
}

/** `tailscale status --json` 在未登录时也可能退出 0，因此按 BackendState 判定而不是只看退出码。 */
export async function readTailscaleStatus(options: TailscaleCommandOptions): Promise<TailscaleStatus> {
  const result = await runTailscaleCommand({ ...options, timeoutMs: options.timeoutMs ?? 8_000 }, ["status", "--json"]);
  let payload: StatusJson;
  try {
    payload = JSON.parse(result.stdout) as StatusJson;
  } catch {
    throw new TailscaleCommandError("tailscale status --json returned invalid JSON", result);
  }
  const tailscaleIPs = Array.isArray(payload.Self?.TailscaleIPs)
    ? payload.Self?.TailscaleIPs.filter((value): value is string => typeof value === "string") ?? []
    : [];
  const dnsName = typeof payload.Self?.DNSName === "string" && payload.Self.DNSName
    ? payload.Self.DNSName.replace(/\.$/, "")
    : null;
  let controlPlaneUrl = null;
  if (payload.BackendState === "Running") {
    const prefs = await runTailscaleCommand(options, ["debug", "prefs"]);
    const { ControlURL } = JSON.parse(prefs.stdout) as { ControlURL?: string };
    if (ControlURL) controlPlaneUrl = new URL(ControlURL).origin;
  }
  return {
    backendState: typeof payload.BackendState === "string" ? payload.BackendState : "Unknown",
    tailscaleIPs,
    dnsName,
    hostname: typeof payload.Self?.HostName === "string" ? payload.Self.HostName : null,
    controlPlaneUrl,
  };
}

/** `tailscale up` 会阻塞到状态收敛；userspace 模式下首联一般数秒内完成。 */
export async function tailscaleUp(
  options: TailscaleCommandOptions,
  config: { loginServer: string; authKey: string; hostname: string; stateDir: string },
): Promise<TailscaleCommandResult> {
  const directory = await mkdtemp(join(config.stateDir, ".auth-"));
  const keyPath = join(directory, "key");
  try {
    await writeFile(keyPath, config.authKey, { mode: 0o600, flag: "wx" });
    return await runTailscaleCommand({ ...options, timeoutMs: options.timeoutMs ?? 60_000 }, [
      "up", `--login-server=${config.loginServer}`, `--auth-key=file:${keyPath}`,
      `--hostname=${config.hostname}`, "--accept-dns=false", "--timeout=30s",
    ]);
  } catch (error) {
    if (error instanceof TailscaleCommandError) {
      throw new Error(error.message.replaceAll(config.authKey, "[redacted]"));
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function tailscaleServe(
  options: TailscaleCommandOptions,
  localUrl: string,
): Promise<TailscaleCommandResult> {
  // --http=80：headscale 不签发 MagicDNS 节点证书，tailnet 内用 80 端口 HTTP 暴露网关。
  return await runTailscaleCommand(options, ["serve", "--bg", "--http=80", localUrl]);
}

export async function tailscaleServeReset(options: TailscaleCommandOptions): Promise<TailscaleCommandResult> {
  return await runTailscaleCommand(options, ["serve", "reset"]);
}

export async function tailscaleLogout(options: TailscaleCommandOptions): Promise<TailscaleCommandResult> {
  return await runTailscaleCommand({ ...options, timeoutMs: options.timeoutMs ?? 20_000 }, ["logout"]);
}

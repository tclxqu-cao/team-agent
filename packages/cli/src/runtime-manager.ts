import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import type { CliOptions } from "./args.js";
import {
  resolveCodexRuntime,
  type CodexRuntimeResolution,
  type ResolveCodexRuntimeOptions,
} from "./codex-runtime-manager.js";
import { repairNativeRuntimePermissions } from "./native-runtime.js";
import type { PairingSecret } from "./pairing.js";
import type { PlatformTarget } from "./platform.js";
import { resolvePlatformRuntime } from "./platform-packages.js";
import { findAvailablePort } from "./port.js";
import { ProcessSupervisor } from "./process-supervisor.js";

export interface RuntimeHandle {
  port: number;
  localUrl: string;
  dataDir: string;
  needsSetup: boolean;
  close(): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  process: ChildProcess;
}

type CodexResolver = (options: ResolveCodexRuntimeOptions) => Promise<CodexRuntimeResolution>;
type RuntimeReporter = (message: string) => void;

export class RuntimeManager {
  constructor(
    private supervisor = new ProcessSupervisor(),
    private codexResolver: CodexResolver = resolveCodexRuntime,
    private report: RuntimeReporter = (message) => process.stderr.write(`${message}\n`),
  ) {}

  async start(
    options: CliOptions,
    pairing: PairingSecret | undefined,
    target: PlatformTarget,
  ): Promise<RuntimeHandle> {
    const port = await findAvailablePort(options.port);
    const dataDir = resolve(options.dataDir);
    await Promise.all(["data", "bin", "cache", "logs"].map((name) => mkdir(resolve(dataDir, name), { recursive: true })));
    const childEnvironment = await prepareCodexRuntimeEnvironment(
      process.env,
      { dataDir, target },
      this.codexResolver,
      this.report,
    );

    const { runtimeRoot } = resolvePlatformRuntime(target);
    await repairNativeRuntimePermissions(runtimeRoot);
    const gateway = resolve(runtimeRoot, "ws-server.mjs");
    const child = this.supervisor.spawn(process.execPath, [gateway], {
      cwd: runtimeRoot,
      env: {
        ...childEnvironment,
        NODE_ENV: "production",
        NEXT_DIST_DIR: ".next",
        PORT: String(port),
        HOST: "127.0.0.1",
        AGENT_DATA_DIR: resolve(dataDir, "data"),
        AGENT_WEB_ROOTS: options.roots.join(delimiter),
        AGENT_TRUST_TUNNEL_PROXY: "1",
        AGENT_PAIRING_HASH: pairing?.hashHex || "",
        AGENT_PAIRING_EXPIRES_AT: pairing?.expiresAt || "",
      },
    });
    const log = (stream: NodeJS.ReadableStream | null) => stream?.on("data", (chunk) => process.stderr.write(chunk));
    log(child.stdout);
    log(child.stderr);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    const localUrl = `http://127.0.0.1:${port}`;
    const status = await waitForHealth(`${localUrl}/api/web-auth/status`, child, 20_000);
    return {
      port,
      localUrl,
      dataDir,
      needsSetup: Boolean(status.needsSetup),
      process: child,
      exited,
      close: () => this.supervisor.stopAll(),
    };
  }
}

export async function prepareCodexRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  options: Pick<ResolveCodexRuntimeOptions, "dataDir" | "target">,
  resolver: CodexResolver = resolveCodexRuntime,
  report: RuntimeReporter = (message) => process.stderr.write(`${message}\n`),
): Promise<NodeJS.ProcessEnv> {
  const childEnvironment = { ...environment };
  report(`Checking Codex ${options.target} runtime...`);
  try {
    const resolution = await resolver({
      ...options,
      environment,
      onProgress: report,
    });
    childEnvironment.AGENT_CODEX_BIN = resolution.executable;
    delete childEnvironment.AGENT_CODEX_RUNTIME_ERROR;
    report(`Codex ${resolution.version} (${resolution.source}): ${resolution.executable}`);
  } catch (error) {
    delete childEnvironment.AGENT_CODEX_BIN;
    const message = error instanceof Error ? error.message : String(error);
    childEnvironment.AGENT_CODEX_RUNTIME_ERROR = message;
    report(
      `Codex unavailable; AgentRoam will continue without Codex sessions: ${message}`,
    );
  }
  return childEnvironment;
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs: number): Promise<{ needsSetup?: boolean }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`local server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json() as Promise<{ needsSetup?: boolean }>;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("local server health check timed out");
}

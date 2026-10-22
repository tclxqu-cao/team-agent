import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliOptions } from "./args.js";
import {
  resolveCodexRuntime,
  type CodexRuntimeResolution,
  type ResolveCodexRuntimeOptions,
} from "./codex-runtime-manager.js";
import { repairNativeRuntimePermissions } from "./native-runtime.js";
import {
  resolveOpenCodeRuntime,
  type OpenCodeRuntimeResolution,
  type ResolveOpenCodeRuntimeOptions,
} from "./opencode-runtime-manager.js";
import type { PlatformTarget } from "./platform.js";
import { resolvePlatformRuntime } from "./platform-packages.js";
import { findAvailablePort } from "./port.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { ensureWindowsBackend } from "./codex-windows-backend.js";
import { configureCodexSharing } from "./codex-sharing.js";
import { withCliProgress } from "../bin/cli-progress.mjs";
import { withAbortSignal, withTimeout } from "./abort.js";

export const CODEX_PREPARATION_TIMEOUT_MS = 180_000;
const OPTIONAL_RUNTIME_CHECK_TIMEOUT_MS = 60_000;
const CODEX_SHARING_TIMEOUT_MS = 10_000;
type RuntimePreparationOptions = Pick<ResolveCodexRuntimeOptions, "dataDir" | "target"> & { timeoutMs?: number };

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
type OpenCodeResolver = (options: ResolveOpenCodeRuntimeOptions) => Promise<OpenCodeRuntimeResolution>;
type RuntimeReporter = (message: string) => void;

export class RuntimeManager {
  constructor(
    private supervisor = new ProcessSupervisor(),
    private codexResolver: CodexResolver = resolveCodexRuntime,
    private report: RuntimeReporter = (message) => process.stderr.write(`${message}\n`),
    private opencodeResolver: OpenCodeResolver = resolveOpenCodeRuntime,
  ) {}

  async start(
    options: CliOptions,
    target: PlatformTarget,
  ): Promise<RuntimeHandle> {
    const port = await findAvailablePort(options.port);
    const dataDir = resolve(options.dataDir);
    await Promise.all(["data", "bin", "cache", "logs"].map((name) => mkdir(resolve(dataDir, name), { recursive: true })));
    const childEnvironment = await withCliProgress("正在检查 Agent 组件；缺少 Codex 时自动安装最新版，最多等待 180 秒", () => prepareAgentRuntimeEnvironment(
      process.env,
      { dataDir, target },
      this.codexResolver,
      this.report,
      this.opencodeResolver,
    ));
    if (process.platform === "darwin" && childEnvironment.AGENT_CODEX_BIN) {
      try {
        await withTimeout(signal => configureCodexSharing(options, { environment: childEnvironment, signal }),
          CODEX_SHARING_TIMEOUT_MS, "Codex 共享后台配置超时（10 秒）");
      }
      catch (error) { this.report(`Codex 共享启动配置未完成，可在电脑菜单中修复：${error instanceof Error ? error.message : error}`); }
    }

    if (process.platform === "win32" && childEnvironment.AGENT_CODEX_BIN) {
      try {
        const backend = await ensureWindowsBackend(dataDir, { environment: childEnvironment });
        childEnvironment.AGENT_CODEX_DESKTOP_WS_URL = backend.endpoint;
      } catch (error) { this.report(`Codex 共享后台未就绪，可在头像菜单重试：${error instanceof Error ? error.message : error}`); }
    }

    const { runtimeRoot } = resolvePlatformRuntime(target);
    await repairNativeRuntimePermissions(runtimeRoot);
    const gateway = resolve(runtimeRoot, "ws-server.mjs");
    const child = this.supervisor.spawn(process.execPath, [gateway, ...(options.testNoPairing ? ["--test-no-pairing"] : [])], {
      cwd: runtimeRoot,
      env: {
        ...childEnvironment,
        NODE_ENV: "production",
        NEXT_DIST_DIR: ".next",
        PORT: String(port),
        HOST: "0.0.0.0",
        AGENT_DATA_DIR: resolve(dataDir, "data"),
        // 应用日志收口到 <dataDir>/logs,与 launchd 的 service.stdout/stderr.log
        // 及 CLI 自身的错误日志同一个目录,用户排障时只需打包这一处。
        AGENT_LOG_DIR: resolve(dataDir, "logs"),
        AGENT_WEB_ROOTS: options.roots.join(delimiter),
        AGENT_TRUST_TUNNEL_PROXY: "1",
        AGENTROAM_VERSION: resolvePlatformRuntime(target).manifest.packageVersion,
        AGENTROAM_DATA_DIR: dataDir,
        AGENTROAM_CLI_PATH: fileURLToPath(new URL("../bin/agentroam.mjs", import.meta.url)),
      },
    });
    const log = (stream: NodeJS.ReadableStream | null) => stream?.on("data", (chunk) => process.stderr.write(chunk));
    log(child.stdout);
    log(child.stderr);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    const localUrl = `http://127.0.0.1:${port}`;
    let status: { needsSetup?: boolean };
    try {
      status = await withCliProgress("正在等待本机服务就绪", () => waitForHealth(`${localUrl}/api/web-auth/status`, child, 20_000));
    } catch (error) {
      await this.supervisor.stopAll();
      throw error;
    }
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

export async function prepareAgentRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  options: RuntimePreparationOptions,
  codexResolver: CodexResolver = resolveCodexRuntime,
  report: RuntimeReporter = (message) => process.stderr.write(`${message}\n`),
  opencodeResolver: OpenCodeResolver = resolveOpenCodeRuntime,
): Promise<NodeJS.ProcessEnv> {
  const [codex, opencode] = await Promise.all([
    prepareCodexRuntimeEnvironment(environment, options, codexResolver, report),
    prepareOpenCodeRuntimeEnvironment(environment, options, opencodeResolver, report),
  ]);
  return {
    ...codex,
    AGENT_OPENCODE_BIN: opencode.AGENT_OPENCODE_BIN,
    AGENT_OPENCODE_RUNTIME_ERROR: opencode.AGENT_OPENCODE_RUNTIME_ERROR,
  };
}

export async function prepareCodexRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  options: RuntimePreparationOptions,
  resolver: CodexResolver = resolveCodexRuntime,
  report: RuntimeReporter = (message) => process.stderr.write(`${message}\n`),
): Promise<NodeJS.ProcessEnv> {
  const childEnvironment = { ...environment };
  const timeoutMs = options.timeoutMs ?? CODEX_PREPARATION_TIMEOUT_MS;
  report(`Checking Codex ${options.target} runtime...`);
  try {
    const resolution = await withTimeout(signal => resolver({
      dataDir: options.dataDir,
      target: options.target,
      signal,
      environment,
      onProgress: report,
    }), timeoutMs, `Codex 组件准备超时（${timeoutMs / 1000} 秒）；请检查网络后运行 agentroam doctor 重试。`);
    childEnvironment.AGENT_CODEX_BIN = resolution.executable;
    delete childEnvironment.AGENT_CODEX_RUNTIME_ERROR;
    report(`Codex ${resolution.version} (${resolution.source}): ${resolution.executable}`);
  } catch (error) {
    delete childEnvironment.AGENT_CODEX_BIN;
    const message = error instanceof Error ? error.message : String(error);
    childEnvironment.AGENT_CODEX_RUNTIME_ERROR = message;
    report(
      `⚠ Codex 会话功能未就绪，局域网服务将继续启动；运行 agentroam doctor 修复后重启服务：${message}`,
    );
  }
  return childEnvironment;
}

export async function prepareOpenCodeRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  options: RuntimePreparationOptions,
  resolver: OpenCodeResolver = resolveOpenCodeRuntime,
  report: RuntimeReporter = (message) => process.stderr.write(`${message}\n`),
): Promise<NodeJS.ProcessEnv> {
  const childEnvironment = { ...environment };
  report(`Checking OpenCode ${options.target} runtime...`);
  try {
    const resolution = await withTimeout(signal => resolver({
      dataDir: options.dataDir, target: options.target, environment, signal, installIfMissing: false, onProgress: report,
    }), options.timeoutMs ?? OPTIONAL_RUNTIME_CHECK_TIMEOUT_MS, "OpenCode 组件检查超时；已跳过，不下载安装。");
    childEnvironment.AGENT_OPENCODE_BIN = resolution.executable;
    delete childEnvironment.AGENT_OPENCODE_RUNTIME_ERROR;
    report(`OpenCode ${resolution.version} (${resolution.source}): ${resolution.executable}`);
  } catch (error) {
    delete childEnvironment.AGENT_OPENCODE_BIN;
    const message = error instanceof Error ? error.message : String(error);
    childEnvironment.AGENT_OPENCODE_RUNTIME_ERROR = message;
    report(`OpenCode 不可用，已跳过（不自动安装）：${message}`);
  }
  return childEnvironment;
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs: number): Promise<{ needsSetup?: boolean }> {
  const end = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("local server health check timed out")), timeoutMs);
  try {
    return await withAbortSignal(async () => {
      while (Date.now() < end) {
        controller.signal.throwIfAborted();
        if (child.exitCode !== null) throw new Error(`local server exited with ${child.exitCode}`);
        try {
          const response = await fetch(url, { signal: controller.signal });
          if (response.ok) return response.json() as Promise<{ needsSetup?: boolean }>;
          void response.body?.cancel().catch(() => {});
        } catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      throw new Error("local server health check timed out");
    }, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

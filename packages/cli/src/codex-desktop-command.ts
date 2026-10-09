import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CliOptions } from "./args.js";
import { resolveCodexRuntime, type CodexRuntimeResolution, type ResolveCodexRuntimeOptions } from "./codex-runtime-manager.js";
import { readServiceConfig, resolveServicePaths, type ServiceConfig } from "./service/service-files.js";
import { detectPlatform } from "./platform.js";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../install/start-codex-desktop-shared.sh", import.meta.url));

interface DesktopCommandContext {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  readConfig?: () => Promise<ServiceConfig | null>;
  codexResolver?: (options: ResolveCodexRuntimeOptions) => Promise<CodexRuntimeResolution>;
  execute?: typeof execFileAsync;
  log?: (message: string) => void;
}

export async function runCodexDesktopCommand(options: CliOptions, context: DesktopCommandContext = {}): Promise<void> {
  const platform = context.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("官方 Codex 桌面共享后端入口目前仅支持 macOS");
  const log = context.log ?? console.log;
  const environment = { ...(context.environment ?? process.env) };
  const service = await (context.readConfig ?? (() => readServiceConfig(resolveServicePaths())))();
  if (service?.dataDir === options.dataDir) {
    if (!environment.AGENT_CODEX_BIN && service.codexPath) environment.AGENT_CODEX_BIN = service.codexPath;
    if (!environment.CODEX_HOME && service.codexHome) environment.CODEX_HOME = service.codexHome;
  }
  // A dry run reads the installed configuration and never installs a runtime.
  if (!options.desktopDryRun) {
    const codex = await (context.codexResolver ?? resolveCodexRuntime)({
      dataDir: options.dataDir,
      target: detectPlatform(platform, process.arch, process.versions.node),
      environment,
      platform,
      nodeExecutable: process.execPath,
      onProgress: (message) => log(`… ${message}`),
    });
    environment.AGENT_CODEX_BIN = codex.executable;
  }
  const args = [scriptPath];
  if (options.desktopRestart) args.push("--restart");
  if (options.desktopDryRun) args.push("--dry-run");
  try {
    const { stdout, stderr } = await (context.execute ?? execFileAsync)("/bin/bash", args, {
      env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    if (stdout.trim()) log(stdout.trimEnd());
    if (stderr.trim()) log(stderr.trimEnd());
  } catch (error) {
    const detail = error as Error & { stderr?: string };
    throw new Error(detail.stderr?.trim() || detail.message, { cause: error });
  }
}

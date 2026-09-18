import { dirname, join, resolve, sep } from "node:path";

// Next.js 打包时会把 import.meta.url 内联成构建机绝对路径，交叉构建到 Windows
// 后 fileURLToPath 在模块导入阶段就抛 ERR_INVALID_FILE_URL_PATH；改用进程入口
// 文件定位包目录，既不依赖构建期路径，也不依赖 launchd 下 cwd(=/) 的进程工作目录。
function defaultServerDir(): string {
  const entry = process.argv[1];
  if (entry) {
    const entryDir = dirname(resolve(entry));
    const binSuffix = `${sep}node_modules${sep}.bin`;
    return entryDir.endsWith(binSuffix) ? resolve(entryDir, "..", "..") : entryDir;
  }
  return resolve(process.cwd());
}

const DEFAULT_SERVER_DIR = defaultServerDir();

export function resolveServerBaseDir(env: NodeJS.ProcessEnv = process.env, fallback = DEFAULT_SERVER_DIR): string {
  return resolve(env.AGENT_DATA_DIR?.trim() || fallback);
}

export function getServerBaseDir(): string { return resolveServerBaseDir(); }

/**
 * 按天日志目录。
 *
 * 优先级:
 *   1. `AGENT_LOG_DIR`             —— 显式覆盖,排障/容器化场景用。
 *   2. `AGENTROAM_DATA_DIR/logs`   —— 安装形态(<dataDir>/logs,默认 ~/.agentroam/logs)。
 *      走这一档是为了 CLI 与 runtime 版本错配(新 runtime + 没注入 AGENT_LOG_DIR 的
 *      旧 CLI)时仍然落在正确位置。
 *   3. `<baseDir>/.agent-data/logs` —— 历史位置(直接 next start、仓库内开发、旧版本)。
 *
 * 安装形态下 2 与 launchd 的 service.stdout.log / service.stderr.log 以及 CLI 自身的
 * <dataDir>/logs/ 同目录 —— 用户排障只需打包这一个文件夹。
 */
export function resolveServerLogDir(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = resolveServerBaseDir(env),
): string {
  const explicit = env.AGENT_LOG_DIR?.trim();
  if (explicit) return resolve(explicit);
  const dataDir = env.AGENTROAM_DATA_DIR?.trim();
  if (dataDir) return resolve(dataDir, "logs");
  return join(baseDir, ".agent-data", "logs");
}

export function getServerLogDir(): string { return resolveServerLogDir(); }

export function resolveAgentWorkingDirectory(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_SERVER_DIR,
): string {
  return resolve(env.AGENT_WORKING_DIRECTORY?.trim() || fallback);
}

export function getAgentWorkingDirectory(): string {
  return resolveAgentWorkingDirectory(process.env, getServerBaseDir());
}

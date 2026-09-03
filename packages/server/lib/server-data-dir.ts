import { dirname, resolve, sep } from "node:path";

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

export function resolveAgentWorkingDirectory(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_SERVER_DIR,
): string {
  return resolve(env.AGENT_WORKING_DIRECTORY?.trim() || fallback);
}

export function getAgentWorkingDirectory(): string {
  return resolveAgentWorkingDirectory(process.env, getServerBaseDir());
}

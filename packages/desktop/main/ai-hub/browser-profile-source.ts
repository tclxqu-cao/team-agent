import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BrowserProfileSourceId = "chrome-default" | "ego-lite-default";

export interface BrowserProfileSource {
  id: BrowserProfileSourceId;
  browserName: string;
  profileName: "Default";
  profilePath: string;
  keychainService: "Chrome Safe Storage" | "ego safe storage";
  available: boolean;
  running: boolean;
  sizeBytes?: number;
  reason?: string;
}

/** 渲染端只拿到清洗后的元数据：绝不含 profilePath / keychainService。 */
export interface BrowserProfileSourceView {
  id: BrowserProfileSourceId;
  browserName: string;
  profileName: "Default";
  available: boolean;
  running: boolean;
  sizeBytes?: number;
  reason?: string;
}

interface SourceDefinition {
  id: BrowserProfileSourceId;
  browserName: string;
  appSupportDirName: string;
  keychainService: BrowserProfileSource["keychainService"];
  processNames: string[];
}

// 固定来源注册表：渲染端只允许提交 id，主进程据此解析路径与 Keychain，
// 任何 API 都不接受渲染层传入的文件系统路径或 Keychain 名称。
const SOURCE_DEFINITIONS: SourceDefinition[] = [
  {
    id: "chrome-default",
    browserName: "Google Chrome",
    appSupportDirName: "Google/Chrome",
    keychainService: "Chrome Safe Storage",
    processNames: ["Google Chrome"],
  },
  {
    id: "ego-lite-default",
    browserName: "ego-lite",
    appSupportDirName: "ego lite",
    keychainService: "ego safe storage",
    processNames: ["ego lite"],
  },
];

export function getProfileSourceDefinition(sourceId: string): SourceDefinition | null {
  return SOURCE_DEFINITIONS.find((source) => source.id === sourceId) ?? null;
}

export function isBrowserProfileSourceId(value: unknown): value is BrowserProfileSourceId {
  return typeof value === "string"
    && SOURCE_DEFINITIONS.some((source) => source.id === value);
}

export interface ProfileSourceDeps {
  homeDir?: string;
  /** 注入进程探测（测试用）；生产实现按进程名精确匹配 pgrep -x。 */
  isProcessRunning?: (processName: string) => Promise<boolean>;
  profileExists?: (profilePath: string) => boolean;
  computeSizeBytes?: (profilePath: string) => Promise<number | undefined>;
}

export function defaultProfilePath(sourceId: BrowserProfileSourceId, homeDir = homedir()): string | null {
  const definition = getProfileSourceDefinition(sourceId);
  if (!definition) return null;
  return join(homeDir, "Library", "Application Support", definition.appSupportDirName, "Default");
}

async function pgrepExact(processName: string): Promise<boolean> {
  // pgrep -x 按进程名精确匹配（macOS p_comm 上限 16 字节，两个名称均未超限）
  try {
    const { stdout } = await execFileAsync("pgrep", ["-x", processName]);
    return stdout.trim().length > 0;
  } catch {
    return false; // pgrep 退出码 1 = 未找到进程
  }
}

export const isProcessNameRunning = pgrepExact;

// 目录求和（仅文件；不跟随符号链接）。失败时返回 undefined（尺寸为可选展示项）。
export async function sumDirectoryBytes(root: string): Promise<number | undefined> {
  const { lstat, readdir } = await import("node:fs/promises");
  interface DirEntry {
    name: string;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  let total = 0;
  const visit = async (dir: string): Promise<void> => {
    let entries: DirEntry[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as DirEntry[];
    } catch {
      throw new Error("unreadable");
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += (await lstat(entryPath)).size;
      } catch {
        // 单个文件不可读不影响汇总
      }
    }
  };
  try {
    await visit(root);
    return total;
  } catch {
    return undefined;
  }
}

export function toSourceView(source: BrowserProfileSource): BrowserProfileSourceView {
  return {
    id: source.id,
    browserName: source.browserName,
    profileName: source.profileName,
    available: source.available,
    running: source.running,
    ...(source.sizeBytes !== undefined ? { sizeBytes: source.sizeBytes } : {}),
    ...(source.reason ? { reason: source.reason } : {}),
  };
}

export async function listBrowserProfileSources(deps: ProfileSourceDeps = {}): Promise<BrowserProfileSource[]> {
  const homeDir = deps.homeDir ?? homedir();
  const isProcessRunning = deps.isProcessRunning ?? pgrepExact;
  const profileExists = deps.profileExists ?? ((path: string) => existsSync(path) && statSync(path).isDirectory());
  const computeSizeBytes = deps.computeSizeBytes ?? sumDirectoryBytes;

  const sources = await Promise.all(SOURCE_DEFINITIONS.map(async (definition): Promise<BrowserProfileSource> => {
    const profilePath = join(homeDir, "Library", "Application Support", definition.appSupportDirName, "Default");
    const available = profileExists(profilePath);
    const running = available ? await isProcessRunning(definition.processNames[0]) : false;
    const sizeBytes = available ? await computeSizeBytes(profilePath) : undefined;
    return {
      id: definition.id,
      browserName: definition.browserName,
      profileName: "Default",
      profilePath,
      keychainService: definition.keychainService,
      available,
      running,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(available ? {} : { reason: "profile-not-found" }),
      ...(running ? { reason: "browser-running" } : {}),
    };
  }));
  return sources;
}

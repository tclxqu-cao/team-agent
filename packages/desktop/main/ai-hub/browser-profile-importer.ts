import { chmod, copyFile, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  collectCookieDetails,
  readChromiumCookieRows,
  readKeychainSecret,
  type ChromiumCookieRow,
  type ElectronCookieDetails,
} from "./cookie-migration.js";
import {
  defaultProfilePath,
  getProfileSourceDefinition,
  sumDirectoryBytes,
  type BrowserProfileSourceId,
} from "./browser-profile-source.js";
import {
  ProfileImportStateStore,
  type ProfileImportErrorCategory,
  type ProfileImportState,
} from "./import-state.js";

export const HUB_PROFILE_DIR_NAME = "ai-hub-browser-profile";
const STAGING_PREFIX = "staging-";
const BACKUP_DIR_NAME = "backup";
const CURRENT_DIR_NAME = "current";

export type ProfileImportPhase = "checking" | "copying" | "importing-cookies" | "validating" | "complete";

export interface BrowserProfileImportResult {
  ok: boolean;
  sourceId: BrowserProfileSourceId;
  errorCategory?: ProfileImportErrorCategory;
  copiedBytes?: number;
  importedCookieCount?: number;
  skippedCookieCount?: number;
  completedAt?: string;
  restartRequired?: boolean;
}

export interface BrowserProfileImportStatus {
  active: boolean;
  restartRequired: boolean;
  sourceId?: string;
  completedAt?: string;
  copiedBytes?: number;
  importedCookieCount?: number;
  skippedCookieCount?: number;
  lastErrorCategory?: ProfileImportErrorCategory;
}

// 拷贝排除策略：运行锁 / 崩溃数据 / 可再生缓存一律不进快照；其余 Profile 数据全量拷贝。
const EXCLUDED_ENTRY_NAMES = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "lockfile",
  "LOCK",
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "Media Cache",
  "Crashpad",
  "Crash Reports",
  "component_crx_cache",
  "DownloadMetadata",
  "Safe Browsing Cookies",
]);

export function shouldExcludeProfileEntry(name: string): boolean {
  return EXCLUDED_ENTRY_NAMES.has(name) || name.endsWith(".tmp");
}

/** 结构校验：快照至少要包含 Preferences / Cookies / Local Storage 之一才算有效 Profile 存储。 */
export function validateStagedProfileEntries(entries: ReadonlyArray<{ name: string; isDirectory: boolean }>): boolean {
  return entries.some((entry) =>
    (entry.name === "Local Storage" && entry.isDirectory)
    || ((entry.name === "Preferences" || entry.name === "Cookies") && !entry.isDirectory));
}

export interface ImportSessionHandle {
  setCookie: (details: ElectronCookieDetails) => Promise<void>;
  flushStore: () => Promise<void>;
}

export interface ProfileImporterDeps {
  destRoot: string;
  stateStore: ProfileImportStateStore;
  isProcessRunning: (processName: string) => Promise<boolean>;
  getSourceProfilePath?: (sourceId: BrowserProfileSourceId) => string | null;
  profileExists?: (profilePath: string) => boolean;
  readKeychainSecret?: typeof readKeychainSecret;
  readCookieRows?: (dbPath: string) => Promise<ChromiumCookieRow[]>;
  createSession?: (profilePath: string) => ImportSessionHandle;
  getAvailableBytes?: (path: string) => Promise<number | null>;
  nowIso?: () => string;
  onProgress?: (phase: ProfileImportPhase) => void;
}

interface CopyStats {
  bytes: number;
  skippedEntries: number;
}

export class BrowserProfileImporter {
  private importInFlight: Promise<BrowserProfileImportResult> | null = null;

  constructor(private readonly deps: ProfileImporterDeps) {}

  get currentProfilePath(): string {
    return join(this.deps.destRoot, CURRENT_DIR_NAME);
  }

  /** 渲染层状态视图：只含元数据与计数。 */
  getStatus(): BrowserProfileImportStatus {
    const state = this.deps.stateStore.load();
    if (!state) return { active: false, restartRequired: false };
    return {
      active: this.deps.profileExists?.(state.destinationPath) ?? existsSync(state.destinationPath),
      restartRequired: state.restartRequired,
      sourceId: state.sourceId,
      completedAt: state.completedAt,
      copiedBytes: state.copiedBytes,
      importedCookieCount: state.importedCookieCount,
      skippedCookieCount: state.skippedCookieCount,
      ...(state.lastErrorCategory ? { lastErrorCategory: state.lastErrorCategory } : {}),
    };
  }

  /** 上次导入后未重启 → 拒绝再次拷贝（进程内 session 缓存按绝对路径持有）。 */
  isRestartPending(): boolean {
    return this.deps.stateStore.load()?.restartRequired === true;
  }

  import(sourceId: string): Promise<BrowserProfileImportResult> {
    if (this.importInFlight) {
      return Promise.resolve({ ok: false, sourceId: safeSourceId(sourceId), errorCategory: "copy-failed" });
    }
    this.importInFlight = this.runImport(sourceId).finally(() => {
      this.importInFlight = null;
    });
    return this.importInFlight;
  }

  private async runImport(sourceId: string): Promise<BrowserProfileImportResult> {
    const definition = getProfileSourceDefinition(sourceId);
    if (!definition) return { ok: false, sourceId: safeSourceId(sourceId), errorCategory: "source-unavailable" };
    try {
      return await this.executeImport(definition.id, definition.processNames[0]);
    } catch (error) {
      console.warn("[ai-hub] profile import failed:", error instanceof Error ? error.message : "unknown error");
      return { ok: false, sourceId: definition.id, errorCategory: "copy-failed" };
    }
  }

  private async executeImport(
    sourceId: BrowserProfileSourceId,
    processName: string,
  ): Promise<BrowserProfileImportResult> {
    const fail = (errorCategory: ProfileImportErrorCategory): BrowserProfileImportResult =>
      ({ ok: false, sourceId, errorCategory });
    const progress = this.deps.onProgress ?? (() => {});

    // ── checking：来源可用、浏览器已退出、磁盘余量充足 ──
    progress("checking");
    const definition = getProfileSourceDefinition(sourceId);
    if (!definition) return fail("source-unavailable");
    // 源路径只由主进程固定注册表推导，从不接受渲染层输入
    const sourceDir = (this.deps.getSourceProfilePath ?? defaultProfilePath)(sourceId);
    if (!sourceDir || !(this.deps.profileExists?.(sourceDir) ?? existsSync(sourceDir))) {
      return fail("source-unavailable");
    }
    if (await this.deps.isProcessRunning(processName)) return fail("source-browser-running");

    const sourceBytes = await sumDirectoryBytes(sourceDir);
    if (sourceBytes !== undefined) {
      const getAvailableBytes = this.deps.getAvailableBytes
        ?? (async (path: string) => {
          try {
            const fsStats = await statfs(path);
            return fsStats.bsize * fsStats.bavail;
          } catch {
            return null;
          }
        });
      const availableBytes = await getAvailableBytes(this.deps.destRoot);
      if (availableBytes !== null && availableBytes < sourceBytes * 1.1) return fail("insufficient-disk-space");
    }

    if (this.isRestartPending()) return fail("restart-required");

    // ── copying：私有 staging 目录 + 显式排除策略 ──
    progress("copying");
    const stagingPath = join(this.deps.destRoot, `${STAGING_PREFIX}${Date.now()}`);
    let copyStats: CopyStats;
    try {
      copyStats = await copyProfileTree(sourceDir, stagingPath);
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      console.warn("[ai-hub] profile copy failed:", error instanceof Error ? error.message : "unknown error");
      return fail("copy-failed");
    }

    // ── importing-cookies：Keychain → v10 解密 → 删除源 cookie 库 ──
    progress("importing-cookies");
    const stagedCookieDb = join(stagingPath, "Cookies");
    let details: ElectronCookieDetails[] = [];
    let importedCookieCount = 0;
    let skippedCookieCount = 0;
    const hadCookieDb = this.deps.profileExists?.(stagedCookieDb) ?? existsSync(stagedCookieDb);
    if (hadCookieDb) {
      const readKeychain = this.deps.readKeychainSecret ?? readKeychainSecret;
      const secret = await readKeychain(definition.keychainService).catch(() => null);
      if (secret === null) {
        await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
        return fail("keychain-denied");
      }
      const rows = await (this.deps.readCookieRows ?? readChromiumCookieRows)(stagedCookieDb).catch(() => null);
      if (rows === null) {
        await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
        return fail("unsupported-profile");
      }
      const summary = collectCookieDetails({ rows, keychainSecret: secret });
      // 关闭失败（fail closed）：Profile 含加密 cookie 却一枚都迁不出来 → 终止导入
      const encryptedRows = rows.filter((row) => (row.encrypted_value?.byteLength ?? 0) > 0);
      if (rows.length > 0 && encryptedRows.length > 0 && summary.imported === 0) {
        await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
        return fail("cookie-migration-failed");
      }
      details = summary.details;
      importedCookieCount = summary.imported;
      skippedCookieCount = summary.skipped.expired + summary.skipped.malformed
        + summary.skipped.partitioned + summary.skipped.undecryptable;
    }
    // 激活前删除拷贝来的 cookie 库：Electron 不得读他 product 加密的密文
    for (const cookieFile of ["Cookies", "Cookies-journal", "Cookies-wal"]) {
      await rm(join(stagingPath, cookieFile), { force: true }).catch(() => undefined);
    }

    // ── validating：激活前确认快照结构完整 ──
    progress("validating");
    const stagedEntries = await readdir(stagingPath, { withFileTypes: true }).catch(() => null);
    if (!stagedEntries || !validateStagedProfileEntries(stagedEntries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })))) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      return fail("validation-failed");
    }

    // ── 激活：current → backup（单个可恢复备份）→ staging → current ──
    const currentPath = this.currentProfilePath;
    const backupPath = join(this.deps.destRoot, BACKUP_DIR_NAME);
    await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
    let previousCurrent: string | null = null;
    if (this.deps.profileExists?.(currentPath) ?? existsSync(currentPath)) {
      await rename(currentPath, backupPath);
      previousCurrent = backupPath;
    }
    try {
      await rename(stagingPath, currentPath);
    } catch (error) {
      if (previousCurrent) await rename(backupPath, currentPath).catch(() => undefined);
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      console.warn("[ai-hub] profile activation failed:", error instanceof Error ? error.message : "unknown error");
      return fail("copy-failed");
    }

    // ── cookie 落库：写入 Electron 自己的加密存储 ──
    let installFailures = 0;
    if (details.length > 0 && this.deps.createSession) {
      const handle = this.deps.createSession(currentPath);
      for (const detail of details) {
        try {
          await handle.setCookie(detail);
        } catch {
          installFailures += 1;
        }
      }
      try {
        await handle.flushStore();
      } catch (error) {
        // flush 失败可恢复（Electron 稍后仍会持久化），不算导入失败
        console.warn("[ai-hub] cookie flush failed:", error instanceof Error ? error.message : "unknown error");
      }
      if (installFailures === details.length) {
        await rm(currentPath, { recursive: true, force: true }).catch(() => undefined);
        if (previousCurrent) await rename(backupPath, currentPath).catch(() => undefined);
        return fail("cookie-migration-failed");
      }
    }

    // ── complete：激活成功后才写元数据 ──
    progress("complete");
    const completedAt = (this.deps.nowIso ?? (() => new Date().toISOString()))();
    const state: ProfileImportState = {
      schemaVersion: 1,
      sourceId,
      completedAt,
      destinationPath: currentPath,
      copiedBytes: copyStats.bytes,
      importedCookieCount,
      skippedCookieCount: skippedCookieCount + installFailures,
      restartRequired: true,
    };
    this.deps.stateStore.save(state);
    return {
      ok: true,
      sourceId,
      copiedBytes: state.copiedBytes,
      importedCookieCount,
      skippedCookieCount: state.skippedCookieCount,
      completedAt,
      restartRequired: true,
    };
  }

  /** 启动维护：清掉遗留 staging，校验 current；坏快照回滚 backup。返回可用 profilePath。 */
  async prepareForStartup(): Promise<{ profilePath: string | null; recovered: boolean }> {
    for (const entry of await readdir(this.deps.destRoot, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)) {
        await rm(join(this.deps.destRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const currentPath = this.currentProfilePath;
    const backupPath = join(this.deps.destRoot, BACKUP_DIR_NAME);
    const currentValid = await this.validateDirectory(currentPath);
    if (currentValid) {
      this.markLoaded();
      return { profilePath: currentPath, recovered: false };
    }
    if (await this.validateDirectory(backupPath)) {
      await rm(currentPath, { recursive: true, force: true }).catch(() => undefined);
      await rename(backupPath, currentPath).catch(() => undefined);
      if (await this.validateDirectory(currentPath)) {
        this.markLoaded();
        return { profilePath: currentPath, recovered: true };
      }
    }
    this.deps.stateStore.save({
      ...(this.deps.stateStore.load() ?? {
        schemaVersion: 1,
        sourceId: "unknown",
        completedAt: (this.deps.nowIso ?? (() => new Date().toISOString()))(),
        destinationPath: currentPath,
        copiedBytes: 0,
        importedCookieCount: 0,
        skippedCookieCount: 0,
      }),
      restartRequired: false,
      lastErrorCategory: "validation-failed",
    });
    return { profilePath: null, recovered: false };
  }

  private markLoaded(): void {
    const state = this.deps.stateStore.load();
    if (!state || !state.restartRequired) return;
    // 本进程已成功加载快照：解除“需重启”闸门，允许后续重新导入
    this.deps.stateStore.save({ ...state, restartRequired: false, lastErrorCategory: undefined });
  }

  private async validateDirectory(path: string): Promise<boolean> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (!entries || entries.length === 0) return false;
    return validateStagedProfileEntries(entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })));
  }
}

function safeSourceId(sourceId: string): BrowserProfileSourceId {
  return (["chrome-default", "ego-lite-default"] as const).includes(sourceId as BrowserProfileSourceId)
    ? sourceId as BrowserProfileSourceId
    : "chrome-default";
}

// 递归拷贝：不跟随符号链接（直接跳过），目标权限收紧到当前用户私有。
async function copyProfileTree(sourceDir: string, destDir: string): Promise<CopyStats> {
  const stats: CopyStats = { bytes: 0, skippedEntries: 0 };
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  const walk = async (src: string, dest: string): Promise<void> => {
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || shouldExcludeProfileEntry(entry.name)) {
        stats.skippedEntries += 1;
        continue;
      }
      const entrySrc = join(src, entry.name);
      const entryDest = join(dest, entry.name);
      if (entry.isDirectory()) {
        await mkdir(entryDest, { mode: 0o700 });
        await walk(entrySrc, entryDest);
        continue;
      }
      if (!entry.isFile()) {
        stats.skippedEntries += 1;
        continue;
      }
      await copyFile(entrySrc, entryDest);
      await chmod(entryDest, 0o600);
      stats.bytes += (await stat(entrySrc)).size;
    }
  };
  await walk(sourceDir, destDir);
  return stats;
}

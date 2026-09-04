import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { availableParallelism } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { encodeUnifiedSessionId } from "./session-id.js";
import type { SessionCompatibility, UnifiedSessionSummary } from "./types.js";

export const CODEX_CATALOG_SCHEMA_VERSION = 1;
export const CODEX_COMPATIBILITY_REGISTRY_VERSION = 1;
export const CODEX_METADATA_LIMIT_BYTES = 256 * 1024;
export const CODEX_CATALOG_WATCH_DEBOUNCE_MS = 500;
export const CODEX_CATALOG_REPAIR_INTERVAL_MS = 60_000;
export const CODEX_CATALOG_BREAKER_MS = 5 * 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLLOUT_ID_PATTERN = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexDiskSessionCatalogEntry {
  canonicalPath: string;
  size: number;
  mtimeNs: string;
  nativeSessionId: string;
  probeable: boolean;
  producerVersion?: string;
  cwd: string;
  created: string;
  updated: string;
  parentSessionId?: string;
  formatKey?: string;
  compatibility: SessionCompatibility;
}

export interface CodexSessionCatalogRepository {
  load(options: {
    schemaVersion: number;
    registryVersion: number;
    readerVersion: string;
  }): CodexDiskSessionCatalogEntry[];
  replace(entries: readonly CodexDiskSessionCatalogEntry[], options: {
    schemaVersion: number;
    registryVersion: number;
    readerVersion: string;
  }): void;
  updateCompatibility(
    canonicalPath: string,
    size: number,
    mtimeNs: string,
    compatibility: SessionCompatibility,
  ): void;
}

export interface CodexSessionCatalogFileSystem {
  listFiles(root: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean; size: number; mtimeNs: string }>;
  readMetadata(path: string, maxBytes: number): Promise<{ text: string; bytesRead: number; complete: boolean }>;
  watch(root: string, onChange: () => void): FSWatcher | null;
}

export interface CodexCatalogScanMetrics {
  durationMs: number;
  filesVisited: number;
  changedFiles: number;
  metadataBytesRead: number;
  cacheHits: number;
  breakerOpen: boolean;
}

export interface CodexSessionDiskCatalogOptions {
  sessionRoot: string;
  readerVersion: string;
  repository: CodexSessionCatalogRepository;
  fileSystem?: CodexSessionCatalogFileSystem;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  setRepeatingTimer?: typeof setInterval;
  clearRepeatingTimer?: typeof clearInterval;
  concurrency?: number;
}

export class CodexSessionDiskCatalog {
  private entries: CodexDiskSessionCatalogEntry[];
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private repairTimer: ReturnType<typeof setInterval> | null = null;
  private scanPromise: Promise<CodexCatalogScanMetrics> | null = null;
  private consecutiveBudgetBreaches = 0;
  private breakerUntil = 0;
  private disposed = false;
  private hasCompletedScan = false;
  private readonly fileSystem: CodexSessionCatalogFileSystem;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly setRepeatingTimer: typeof setInterval;
  private readonly clearRepeatingTimer: typeof clearInterval;
  private readonly concurrency: number;

  constructor(private readonly options: CodexSessionDiskCatalogOptions) {
    this.fileSystem = options.fileSystem ?? nodeCatalogFileSystem;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.setRepeatingTimer = options.setRepeatingTimer ?? setInterval;
    this.clearRepeatingTimer = options.clearRepeatingTimer ?? clearInterval;
    this.concurrency = Math.max(1, Math.min(
      options.concurrency ?? availableParallelism(),
      availableParallelism(),
      8,
    ));
    this.entries = options.repository.load(this.cacheIdentity());
  }

  snapshot(): readonly CodexDiskSessionCatalogEntry[] {
    return this.entries;
  }

  summaries(): UnifiedSessionSummary[] {
    return this.entries.map((entry) => catalogEntryToSummary(entry));
  }

  findByNativeSessionId(nativeSessionId: string): CodexDiskSessionCatalogEntry | undefined {
    return this.entries.find((entry) => entry.nativeSessionId === nativeSessionId);
  }

  start(): void {
    if (this.disposed || this.repairTimer) return;
    void this.scheduleReconciliation();
    this.fileSystem.realpath(this.options.sessionRoot).then((root) => {
      if (this.disposed) return;
      this.watcher = this.fileSystem.watch(root, () => this.scheduleDebouncedReconciliation());
    }).catch(() => undefined);
    this.repairTimer = this.setRepeatingTimer(() => {
      void this.scheduleReconciliation();
    }, CODEX_CATALOG_REPAIR_INTERVAL_MS);
    this.repairTimer.unref?.();
  }

  scheduleReconciliation(manual = false): Promise<CodexCatalogScanMetrics> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.reconcile(manual).finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  async reconcile(manual = false): Promise<CodexCatalogScanMetrics> {
    const startedAt = this.now();
    if (this.disposed || (!manual && this.breakerUntil > startedAt)) {
      return emptyMetrics(this.breakerUntil > startedAt);
    }

    let root: string;
    let files: string[];
    try {
      root = await this.fileSystem.realpath(this.options.sessionRoot);
      files = await this.fileSystem.listFiles(root);
    } catch {
      return emptyMetrics(false);
    }

    const cached = new Map(this.entries.map((entry) => [entry.canonicalPath, entry]));
    const next = new Array<CodexDiskSessionCatalogEntry | null>(files.length).fill(null);
    let nextIndex = 0;
    let changedFiles = 0;
    let metadataBytesRead = 0;
    let cacheHits = 0;

    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= files.length) return;
        const candidate = files[index];
        try {
          const canonicalPath = await this.fileSystem.realpath(candidate);
          if (!isPathBelow(root, canonicalPath)) continue;
          const fileStat = await this.fileSystem.stat(canonicalPath);
          if (!fileStat.isFile()) continue;
          const previous = cached.get(canonicalPath);
          if (previous && previous.size === fileStat.size && previous.mtimeNs === fileStat.mtimeNs) {
            next[index] = previous;
            cacheHits += 1;
            continue;
          }
          changedFiles += 1;
          const metadata = await this.fileSystem.readMetadata(canonicalPath, CODEX_METADATA_LIMIT_BYTES);
          metadataBytesRead += metadata.bytesRead;
          next[index] = parseCatalogEntry(canonicalPath, fileStat, metadata, this.options.readerVersion);
        } catch {
          // Each rollout is isolated. A disappearing or unreadable file cannot abort the catalog.
        }
        if ((index + 1) % 32 === 0) await new Promise<void>((resolveYield) => setImmediate(resolveYield));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, files.length)) }, worker));

    const nextEntries = next.filter((entry): entry is CodexDiskSessionCatalogEntry => entry !== null)
      .sort((left, right) => right.updated.localeCompare(left.updated) || left.nativeSessionId.localeCompare(right.nativeSessionId));
    const membershipChanged = nextEntries.length !== this.entries.length
      || nextEntries.some((entry, index) => entry.canonicalPath !== this.entries[index]?.canonicalPath);
    this.entries = nextEntries;
    if (changedFiles > 0 || membershipChanged) {
      this.options.repository.replace(this.entries, this.cacheIdentity());
    }
    const durationMs = Math.max(0, this.now() - startedAt);
    const budgetMs = this.hasCompletedScan ? 200 : 1_000;
    this.hasCompletedScan = true;
    if (durationMs > budgetMs) this.consecutiveBudgetBreaches += 1;
    else this.consecutiveBudgetBreaches = 0;
    if (this.consecutiveBudgetBreaches >= 3) {
      this.breakerUntil = this.now() + CODEX_CATALOG_BREAKER_MS;
      this.consecutiveBudgetBreaches = 0;
    }
    return {
      durationMs,
      filesVisited: files.length,
      changedFiles,
      metadataBytesRead,
      cacheHits,
      breakerOpen: this.breakerUntil > this.now(),
    };
  }

  updateCompatibility(nativeSessionId: string, compatibility: SessionCompatibility): void {
    const index = this.entries.findIndex((entry) => entry.nativeSessionId === nativeSessionId);
    if (index < 0) return;
    const current = this.entries[index];
    const updated = { ...current, compatibility };
    this.entries = this.entries.map((entry, entryIndex) => entryIndex === index ? updated : entry);
    this.options.repository.updateCompatibility(
      current.canonicalPath,
      current.size,
      current.mtimeNs,
      compatibility,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.debounceTimer) this.clearTimer(this.debounceTimer);
    if (this.repairTimer) this.clearRepeatingTimer(this.repairTimer);
    this.debounceTimer = null;
    this.repairTimer = null;
  }

  private cacheIdentity() {
    return {
      schemaVersion: CODEX_CATALOG_SCHEMA_VERSION,
      registryVersion: CODEX_COMPATIBILITY_REGISTRY_VERSION,
      readerVersion: this.options.readerVersion,
    };
  }

  private scheduleDebouncedReconciliation(): void {
    if (this.debounceTimer) this.clearTimer(this.debounceTimer);
    this.debounceTimer = this.setTimer(() => {
      this.debounceTimer = null;
      void this.scheduleReconciliation();
    }, CODEX_CATALOG_WATCH_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }
}

export function catalogEntryToSummary(entry: CodexDiskSessionCatalogEntry): UnifiedSessionSummary {
  const day = entry.created.slice(0, 10);
  return {
    id: encodeUnifiedSessionId("codex", entry.nativeSessionId),
    agentType: "codex",
    nativeSessionId: entry.nativeSessionId,
    title: `Codex 会话 ${day}`,
    cwd: entry.cwd,
    ...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
    created: entry.created,
    updated: entry.updated,
    status: "idle",
    occupancy: "available",
    sourceLabel: entry.producerVersion ? `Codex ${entry.producerVersion}` : "Codex",
    canResume: entry.compatibility.status === "direct",
    canDelete: true,
    compatibility: entry.compatibility,
  };
}

export function parseCatalogEntry(
  canonicalPath: string,
  fileStat: { size: number; mtimeNs: string },
  metadata: { text: string; bytesRead: number; complete: boolean },
  readerVersion: string,
): CodexDiskSessionCatalogEntry {
  const fallbackId = rolloutIdFromPath(canonicalPath);
  const diagnosticId = `catalog:${createHash("sha256").update(canonicalPath).digest("base64url").slice(0, 24)}`;
  const updated = timestampFromMtimeNs(fileStat.mtimeNs);
  let parsed: { type?: unknown; payload?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(metadata.text) as { type?: unknown; payload?: Record<string, unknown> };
  } catch {
    parsed = null;
  }
  const payload = parsed?.type === "session_meta" && parsed.payload && typeof parsed.payload === "object"
    ? parsed.payload
    : null;
  const metadataId = typeof payload?.id === "string" && UUID_PATTERN.test(payload.id) ? payload.id : undefined;
  const nativeSessionId = metadataId ?? fallbackId ?? diagnosticId;
  const producerVersion = stringValue(payload?.cli_version);
  const created = validTimestamp(stringValue(payload?.timestamp)) ?? updated;
  const cwd = stringValue(payload?.cwd) ?? "";
  const parentSessionId = stringValue(payload?.parent_thread_id) ?? stringValue(payload?.parent_id);
  const formatKey = payload ? fingerprintSessionMeta(payload) : undefined;
  const reason = !metadata.complete
    ? `会话元数据超过 ${CODEX_METADATA_LIMIT_BYTES / 1024} KiB 安全上限`
    : payload
      ? undefined
      : "无法识别会话元数据格式";
  const compatibility: SessionCompatibility = reason || !metadataId && !fallbackId
    ? {
        status: "incompatible",
        readerVersion,
        ...(producerVersion ? { producerVersion } : {}),
        ...(formatKey ? { formatKey } : {}),
        reasonCode: "CODEX_SESSION_SCHEMA_UNKNOWN",
        reason: reason ?? "无法恢复可验证的 Codex 会话 ID",
      }
    : {
        status: "checking",
        readerVersion,
        ...(producerVersion ? { producerVersion } : {}),
        ...(formatKey ? { formatKey } : {}),
      };
  return {
    canonicalPath,
    size: fileStat.size,
    mtimeNs: fileStat.mtimeNs,
    nativeSessionId,
    probeable: Boolean(metadataId || fallbackId),
    ...(producerVersion ? { producerVersion } : {}),
    cwd,
    created,
    updated,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(formatKey ? { formatKey } : {}),
    compatibility,
  };
}

export const nodeCatalogFileSystem: CodexSessionCatalogFileSystem = {
  async listFiles(root) {
    const files: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
      }
      if (pending.length % 32 === 0) await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
    return files;
  },
  realpath,
  async stat(path) {
    const value = await stat(path, { bigint: true });
    return {
      isFile: () => value.isFile(),
      size: Number(value.size),
      mtimeNs: value.mtimeNs.toString(),
    };
  },
  async readMetadata(path, maxBytes) {
    const handle = await open(path, "r");
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let complete = false;
    try {
      while (bytesRead < maxBytes) {
        const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, maxBytes - bytesRead));
        const read = await handle.read(chunk, 0, chunk.length, bytesRead);
        if (read.bytesRead === 0) {
          complete = true;
          break;
        }
        bytesRead += read.bytesRead;
        const used = chunk.subarray(0, read.bytesRead);
        const newline = used.indexOf(0x0a);
        chunks.push(newline >= 0 ? used.subarray(0, newline) : used);
        if (newline >= 0) {
          complete = true;
          break;
        }
      }
      return { text: Buffer.concat(chunks).toString("utf8"), bytesRead, complete };
    } finally {
      await handle.close();
    }
  },
  watch(root, onChange) {
    try {
      return watch(root, { recursive: true }, onChange);
    } catch {
      return null;
    }
  },
};

function rolloutIdFromPath(path: string): string | undefined {
  const filename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return ROLLOUT_ID_PATTERN.exec(filename)?.[1];
}

function fingerprintSessionMeta(payload: Record<string, unknown>): string {
  const shape = Object.keys(payload).sort().map((key) => {
    const value = payload[key];
    if (Array.isArray(value)) return `${key}:array`;
    if (value && typeof value === "object") return `${key}:{${Object.keys(value as object).sort().join(",")}}`;
    return `${key}:${typeof value}`;
  }).join("|");
  return `meta-v1:${createHash("sha256").update(shape).digest("base64url").slice(0, 16)}`;
}

function timestampFromMtimeNs(mtimeNs: string): string {
  const milliseconds = Number(BigInt(mtimeNs) / 1_000_000n);
  return new Date(milliseconds).toISOString();
}

function validTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPathBelow(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot !== ""
    && fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot);
}

function emptyMetrics(breakerOpen: boolean): CodexCatalogScanMetrics {
  return {
    durationMs: 0,
    filesVisited: 0,
    changedFiles: 0,
    metadataBytesRead: 0,
    cacheHits: 0,
    breakerOpen,
  };
}

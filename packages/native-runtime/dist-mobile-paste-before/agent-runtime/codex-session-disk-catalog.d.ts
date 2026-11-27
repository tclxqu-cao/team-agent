import { type FSWatcher } from "node:fs";
import type { SessionCompatibility, UnifiedSessionSummary } from "./types.js";
export declare const CODEX_CATALOG_SCHEMA_VERSION = 1;
export declare const CODEX_COMPATIBILITY_REGISTRY_VERSION = 1;
export declare const CODEX_METADATA_LIMIT_BYTES: number;
export declare const CODEX_CATALOG_WATCH_DEBOUNCE_MS = 500;
export declare const CODEX_CATALOG_REPAIR_INTERVAL_MS = 60000;
export declare const CODEX_CATALOG_BREAKER_MS: number;
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
    updateCompatibility(canonicalPath: string, size: number, mtimeNs: string, compatibility: SessionCompatibility): void;
}
export interface CodexSessionCatalogFileSystem {
    listFiles(root: string): Promise<string[]>;
    realpath(path: string): Promise<string>;
    stat(path: string): Promise<{
        isFile(): boolean;
        size: number;
        mtimeNs: string;
    }>;
    readMetadata(path: string, maxBytes: number): Promise<{
        text: string;
        bytesRead: number;
        complete: boolean;
    }>;
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
export declare class CodexSessionDiskCatalog {
    private readonly options;
    private entries;
    private watcher;
    private debounceTimer;
    private repairTimer;
    private scanPromise;
    private consecutiveBudgetBreaches;
    private breakerUntil;
    private disposed;
    private hasCompletedScan;
    private readonly fileSystem;
    private readonly now;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly setRepeatingTimer;
    private readonly clearRepeatingTimer;
    private readonly concurrency;
    private onCheckingEntry?;
    constructor(options: CodexSessionDiskCatalogOptions);
    snapshot(): readonly CodexDiskSessionCatalogEntry[];
    summaries(): UnifiedSessionSummary[];
    findByNativeSessionId(nativeSessionId: string): CodexDiskSessionCatalogEntry | undefined;
    setOnCheckingEntry(callback?: (entry: CodexDiskSessionCatalogEntry) => void): void;
    start(): void;
    scheduleReconciliation(manual?: boolean): Promise<CodexCatalogScanMetrics>;
    reconcile(manual?: boolean): Promise<CodexCatalogScanMetrics>;
    updateCompatibility(nativeSessionId: string, compatibility: SessionCompatibility): void;
    dispose(): void;
    private cacheIdentity;
    private scheduleDebouncedReconciliation;
}
export declare function catalogEntryToSummary(entry: CodexDiskSessionCatalogEntry): UnifiedSessionSummary;
export declare function parseCatalogEntry(canonicalPath: string, fileStat: {
    size: number;
    mtimeNs: string;
}, metadata: {
    text: string;
    bytesRead: number;
    complete: boolean;
}, readerVersion: string): CodexDiskSessionCatalogEntry;
export declare const nodeCatalogFileSystem: CodexSessionCatalogFileSystem;
//# sourceMappingURL=codex-session-disk-catalog.d.ts.map
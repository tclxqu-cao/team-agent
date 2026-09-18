import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_METADATA_LIMIT_BYTES,
  CodexSessionDiskCatalog,
  nodeCatalogFileSystem,
  parseCatalogEntry,
  type CodexDiskSessionCatalogEntry,
  type CodexSessionCatalogRepository,
} from "./codex-session-disk-catalog.js";
import type { SessionCompatibility } from "./types.js";

class MemoryCatalogRepository implements CodexSessionCatalogRepository {
  entries: CodexDiskSessionCatalogEntry[] = [];
  replaceCalls = 0;

  load(): CodexDiskSessionCatalogEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  replace(entries: readonly CodexDiskSessionCatalogEntry[]): void {
    this.replaceCalls += 1;
    this.entries = entries.map((entry) => ({ ...entry }));
  }

  updateCompatibility(path: string, size: number, mtimeNs: string, compatibility: SessionCompatibility): void {
    this.entries = this.entries.map((entry) => (
      entry.canonicalPath === path && entry.size === size && entry.mtimeNs === mtimeNs
        ? { ...entry, compatibility }
        : entry
    ));
  }
}

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempSessionRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-catalog-"));
  cleanup.push(root);
  await mkdir(join(root, "2026", "09", "04"), { recursive: true });
  return root;
}

function rolloutPath(root: string, id: string): string {
  return join(root, "2026", "09", "04", `rollout-2026-09-04T12-00-00-${id}.jsonl`);
}

function metadata(id: string, version = "0.140.0"): string {
  return JSON.stringify({
    timestamp: "2026-09-04T04:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      timestamp: "2026-09-04T04:00:00.000Z",
      cwd: "/repo",
      cli_version: version,
      source: "cli",
    },
  });
}

describe("CodexSessionDiskCatalog", () => {
  it("reads only changed headers and performs zero rollout-content reads on a warm scan", async () => {
    const root = await tempSessionRoot();
    const firstId = "019f0000-0000-7000-8000-000000000001";
    const secondId = "019f0000-0000-7000-8000-000000000002";
    const first = rolloutPath(root, firstId);
    const second = rolloutPath(root, secondId);
    await writeFile(first, `${metadata(firstId)}\n${"x".repeat(128 * 1024)}\n`);
    await writeFile(second, `${metadata(secondId)}\nbody\n`);
    const repository = new MemoryCatalogRepository();
    const readMetadata = vi.fn(nodeCatalogFileSystem.readMetadata);
    const catalog = new CodexSessionDiskCatalog({
      sessionRoot: root,
      readerVersion: "0.153.0",
      repository,
      fileSystem: { ...nodeCatalogFileSystem, readMetadata },
    });

    const cold = await catalog.reconcile();
    expect(cold.changedFiles).toBe(2);
    expect(cold.metadataBytesRead).toBeLessThanOrEqual(2 * CODEX_METADATA_LIMIT_BYTES);
    expect(catalog.snapshot().map((entry) => entry.nativeSessionId).sort()).toEqual([firstId, secondId]);

    readMetadata.mockClear();
    const warm = await catalog.reconcile();
    expect(warm).toMatchObject({ changedFiles: 0, metadataBytesRead: 0, cacheHits: 2 });
    expect(readMetadata).not.toHaveBeenCalled();
    expect(repository.replaceCalls).toBe(1);
  });

  it("rereads only the modified rollout and keeps metadata reads capped", async () => {
    const root = await tempSessionRoot();
    const firstId = "019f0000-0000-7000-8000-000000000011";
    const secondId = "019f0000-0000-7000-8000-000000000012";
    const first = rolloutPath(root, firstId);
    const second = rolloutPath(root, secondId);
    await writeFile(first, `${metadata(firstId)}\nold\n`);
    await writeFile(second, `${metadata(secondId)}\nstable\n`);
    const repository = new MemoryCatalogRepository();
    const readMetadata = vi.fn(nodeCatalogFileSystem.readMetadata);
    const catalog = new CodexSessionDiskCatalog({
      sessionRoot: root,
      readerVersion: "0.153.0",
      repository,
      fileSystem: { ...nodeCatalogFileSystem, readMetadata },
    });
    await catalog.reconcile();
    readMetadata.mockClear();

    await writeFile(first, `${metadata(firstId, "0.141.0")}\n${"z".repeat(512 * 1024)}\n`);
    const incremental = await catalog.reconcile();

    expect(incremental.changedFiles).toBe(1);
    expect(incremental.metadataBytesRead).toBeLessThanOrEqual(CODEX_METADATA_LIMIT_BYTES);
    expect(readMetadata).toHaveBeenCalledTimes(1);
    expect(catalog.findByNativeSessionId(firstId)?.producerVersion).toBe("0.141.0");
  });

  it("notifies checking entries only after the initial scan", async () => {
    const root = await tempSessionRoot();
    const firstId = "019f0000-0000-7000-8000-000000000013";
    const first = rolloutPath(root, firstId);
    await writeFile(first, `${metadata(firstId)}\nold\n`);
    const catalog = new CodexSessionDiskCatalog({
      sessionRoot: root,
      readerVersion: "0.153.0",
      repository: new MemoryCatalogRepository(),
    });
    const onCheckingEntry = vi.fn();
    catalog.setOnCheckingEntry(onCheckingEntry);

    await catalog.reconcile();
    expect(onCheckingEntry).not.toHaveBeenCalled();

    await writeFile(first, `${metadata(firstId, "0.153.0")}\nchanged body\n`);
    await catalog.reconcile();

    expect(onCheckingEntry).toHaveBeenCalledTimes(1);
    expect(onCheckingEntry).toHaveBeenCalledWith(expect.objectContaining({
      nativeSessionId: firstId,
      producerVersion: "0.153.0",
      compatibility: expect.objectContaining({ status: "checking" }),
    }));
  });

  it("preserves settled compatibility when only the rollout body grows", async () => {
    const root = await tempSessionRoot();
    const firstId = "019f0000-0000-7000-8000-000000000014";
    const first = rolloutPath(root, firstId);
    await writeFile(first, `${metadata(firstId, "0.153.0")}\nold\n`);
    const catalog = new CodexSessionDiskCatalog({
      sessionRoot: root,
      readerVersion: "0.153.0",
      repository: new MemoryCatalogRepository(),
    });
    const onCheckingEntry = vi.fn();
    catalog.setOnCheckingEntry(onCheckingEntry);
    await catalog.reconcile();
    catalog.updateCompatibility(firstId, {
      status: "direct",
      readerVersion: "0.153.0",
      producerVersion: "0.153.0",
    });

    await writeFile(first, `${metadata(firstId, "0.153.0")}\nbody grew without metadata changes\n`);
    await catalog.reconcile();

    expect(catalog.findByNativeSessionId(firstId)?.compatibility.status).toBe("direct");
    expect(onCheckingEntry).not.toHaveBeenCalled();
  });

  it("isolates malformed metadata, recovers strict filename IDs, and rejects symlinks", async () => {
    const root = await tempSessionRoot();
    const recoveredId = "019f0000-0000-7000-8000-000000000021";
    await writeFile(rolloutPath(root, recoveredId), "not-json\nbody\n");
    const external = await mkdtemp(join(tmpdir(), "codex-catalog-external-"));
    cleanup.push(external);
    const escapedId = "019f0000-0000-7000-8000-000000000022";
    const escaped = join(external, `rollout-2026-09-04T12-00-00-${escapedId}.jsonl`);
    await writeFile(escaped, `${metadata(escapedId)}\n`);
    await symlink(escaped, join(root, "2026", "09", "04", "escaped.jsonl"));
    const catalog = new CodexSessionDiskCatalog({
      sessionRoot: root,
      readerVersion: "0.153.0",
      repository: new MemoryCatalogRepository(),
    });

    await catalog.reconcile();

    expect(catalog.snapshot()).toHaveLength(1);
    expect(catalog.snapshot()[0]).toMatchObject({
      nativeSessionId: recoveredId,
      probeable: true,
      compatibility: { status: "incompatible", reasonCode: "CODEX_SESSION_SCHEMA_UNKNOWN" },
    });
  });

  it("marks an over-limit first record incompatible", () => {
    const entry = parseCatalogEntry(
      "/sessions/unknown.jsonl",
      { size: CODEX_METADATA_LIMIT_BYTES + 1, mtimeNs: "1725422400000000000" },
      { text: "{", bytesRead: CODEX_METADATA_LIMIT_BYTES, complete: false },
      "0.153.0",
    );

    expect(entry).toMatchObject({
      probeable: false,
      compatibility: {
        status: "incompatible",
        reasonCode: "CODEX_SESSION_SCHEMA_UNKNOWN",
      },
    });
    expect(entry.compatibility.reason).toContain("256 KiB");
  });

  it("opens the automatic-scan circuit breaker after three budget breaches", async () => {
    let currentTime = 0;
    const listFiles = vi.fn(async () => {
      currentTime += 1_100;
      return [];
    });
    const catalog = new CodexSessionDiskCatalog({
      sessionRoot: "/sessions",
      readerVersion: "0.153.0",
      repository: new MemoryCatalogRepository(),
      now: () => currentTime,
      fileSystem: {
        listFiles,
        realpath: async (path) => path,
        stat: async () => ({ isFile: () => true, size: 0, mtimeNs: "0" }),
        readMetadata: async () => ({ text: "", bytesRead: 0, complete: true }),
        watch: () => null,
      },
    });

    await catalog.reconcile();
    await catalog.reconcile();
    const third = await catalog.reconcile();
    const blocked = await catalog.reconcile();

    expect(third.breakerOpen).toBe(true);
    expect(blocked).toMatchObject({ filesVisited: 0, breakerOpen: true });
    expect(listFiles).toHaveBeenCalledTimes(3);
    await catalog.reconcile(true);
    expect(listFiles).toHaveBeenCalledTimes(4);
  });
});

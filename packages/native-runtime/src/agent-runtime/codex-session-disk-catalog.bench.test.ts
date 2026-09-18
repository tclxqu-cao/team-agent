import { monitorEventLoopDelay } from "node:perf_hooks";
import { appendFile, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CodexSessionDiskCatalog,
  type CodexDiskSessionCatalogEntry,
  type CodexSessionCatalogRepository,
} from "./codex-session-disk-catalog.js";
import type { SessionCompatibility } from "./types.js";

const runBenchmark = process.env.RUN_CODEX_COMPAT_BENCHMARK === "1";
const benchmarkIt = runBenchmark ? it : it.skip;
let benchmarkRoot: string | null = null;

class BenchmarkRepository implements CodexSessionCatalogRepository {
  entries: CodexDiskSessionCatalogEntry[] = [];
  load() { return this.entries; }
  replace(entries: readonly CodexDiskSessionCatalogEntry[]) { this.entries = [...entries]; }
  updateCompatibility(path: string, size: number, mtimeNs: string, compatibility: SessionCompatibility) {
    this.entries = this.entries.map((entry) => entry.canonicalPath === path && entry.size === size && entry.mtimeNs === mtimeNs
      ? { ...entry, compatibility }
      : entry);
  }
}

afterAll(async () => {
  if (benchmarkRoot) await rm(benchmarkRoot, { recursive: true, force: true });
});

describe("Codex disk catalog release performance", () => {
  benchmarkIt("indexes a sparse 1,000-file / 4-GiB corpus within release budgets", async () => {
    benchmarkRoot = await mkdtemp(join(tmpdir(), "codex-catalog-benchmark-"));
    const directory = join(benchmarkRoot, "2026", "09", "04");
    await mkdir(directory, { recursive: true });
    const files: string[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      const id = `019f0000-0000-7000-8000-${suffix}`;
      const path = join(directory, `rollout-2026-09-04T12-00-00-${id}.jsonl`);
      const header = JSON.stringify({
        type: "session_meta",
        payload: { id, cli_version: "0.140.0", cwd: "/repo", timestamp: "2026-09-04T00:00:00.000Z" },
      });
      await writeFile(path, `${header}\n`);
      await truncate(path, 4 * 1024 * 1024);
      files.push(path);
    }
    const catalog = new CodexSessionDiskCatalog({
      sessionRoot: benchmarkRoot,
      readerVersion: "0.153.0",
      repository: new BenchmarkRepository(),
    });
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();

    const cold = await catalog.reconcile();
    const warm = await catalog.reconcile();
    for (const path of files.slice(0, 3)) await appendFile(path, "x");
    const incremental = await catalog.reconcile();
    delay.disable();

    expect(cold.filesVisited).toBe(1_000);
    expect(cold.durationMs).toBeLessThan(1_000);
    expect(warm).toMatchObject({ changedFiles: 0, metadataBytesRead: 0, cacheHits: 1_000 });
    expect(incremental.changedFiles).toBe(3);
    expect(incremental.durationMs).toBeLessThan(200);
    expect(delay.percentile(99) / 1_000_000).toBeLessThan(50);
  }, 30_000);
});

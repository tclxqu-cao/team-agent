import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeAdapter, SessionCompatibility, UnifiedSessionDetail } from "./types.js";
import { RuntimeSessionError } from "./types.js";
import {
  CodexSessionDiskCatalog,
  type CodexDiskSessionCatalogEntry,
  type CodexSessionCatalogFileSystem,
  type CodexSessionCatalogRepository,
} from "./codex-session-disk-catalog.js";
import { CodexSessionCompatibilityService } from "./codex-session-compatibility.js";

const nativeId = "019f0000-0000-7000-8000-000000000101";

function entry(overrides: Partial<CodexDiskSessionCatalogEntry> = {}): CodexDiskSessionCatalogEntry {
  return {
    canonicalPath: "/sessions/legacy.jsonl",
    size: 100,
    mtimeNs: "1",
    nativeSessionId: nativeId,
    probeable: true,
    producerVersion: "0.122.0",
    cwd: "/repo",
    created: "2026-09-04T00:00:00.000Z",
    updated: "2026-09-04T00:00:00.000Z",
    formatKey: "meta-v1:test",
    compatibility: { status: "checking", producerVersion: "0.122.0", readerVersion: "0.153.0" },
    ...overrides,
  };
}

class SeedRepository implements CodexSessionCatalogRepository {
  constructor(public entries = [entry()]) {}
  load() { return this.entries; }
  replace(entries: readonly CodexDiskSessionCatalogEntry[]) { this.entries = [...entries]; }
  updateCompatibility(path: string, size: number, mtimeNs: string, compatibility: SessionCompatibility) {
    this.entries = this.entries.map((item) => item.canonicalPath === path && item.size === size && item.mtimeNs === mtimeNs
      ? { ...item, compatibility }
      : item);
  }
}

function detail(): UnifiedSessionDetail {
  return {
    id: "runtime:codex:test",
    agentType: "codex",
    nativeSessionId: nativeId,
    title: "Readable",
    cwd: "/repo",
    created: "2026-09-04T00:00:00.000Z",
    updated: "2026-09-04T00:00:00.000Z",
    status: "idle",
    occupancy: "available",
    sourceLabel: "Codex",
    canResume: true,
    canDelete: true,
    messages: [],
    events: [],
  };
}

function adapter(read: () => Promise<UnifiedSessionDetail>): AgentRuntimeAdapter {
  return {
    agentType: "codex",
    health: async () => ({ agentType: "codex", available: true, label: "Codex" }),
    discoverSessions: async () => [],
    getSession: vi.fn(read),
    create: async () => { throw new Error("unused"); },
    run: async function* () {},
    abort: async () => undefined,
    answerQuestion: async () => false,
  };
}

function catalog(repository: SeedRepository, fileSystem?: CodexSessionCatalogFileSystem) {
  return new CodexSessionDiskCatalog({
    sessionRoot: "/sessions",
    readerVersion: "0.153.0",
    repository,
    ...(fileSystem ? { fileSystem } : {}),
  });
}

describe("CodexSessionCompatibilityService", () => {
  it("keeps primary rows unchanged and appends only missing disk IDs", () => {
    const repository = new SeedRepository();
    const runtime = adapter(async () => detail());
    const service = new CodexSessionCompatibilityService(runtime, catalog(repository));
    const primary = [{ ...detail(), messages: undefined, events: undefined } as never];

    expect(service.supplement(primary)).toEqual(primary);
    expect(runtime.getSession).not.toHaveBeenCalled();
  });

  it("returns the existing adapter detail unchanged after a successful explicit probe", async () => {
    const repository = new SeedRepository();
    const expected = detail();
    const runtime = adapter(async () => expected);
    const service = new CodexSessionCompatibilityService(runtime, catalog(repository));
    expect(service.supplement([])).toHaveLength(1);

    await expect(service.readSupplemental(nativeId)).resolves.toBe(expected);
    expect(runtime.getSession).toHaveBeenCalledWith(nativeId);
    expect(repository.entries[0].compatibility.status).toBe("direct");
  });

  it("fails closed with producer and reader versions when the unchanged reader rejects the session", async () => {
    const repository = new SeedRepository();
    const runtime = adapter(async () => { throw new RuntimeSessionError("bad shape", "NATIVE_PROTOCOL_ERROR"); });
    const service = new CodexSessionCompatibilityService(runtime, catalog(repository));
    service.supplement([]);

    await expect(service.readSupplemental(nativeId)).rejects.toMatchObject({
      code: "CODEX_SESSION_VERSION_INCOMPATIBLE",
      message: "该会话由 Codex 0.122.0 创建，当前 Codex 0.153.0 无法读取",
    });
    expect(repository.entries[0].compatibility).toMatchObject({
      status: "incompatible",
      reasonCode: "CODEX_SESSION_DIRECT_READ_FAILED",
    });
  });

  it("never sends an unvalidated catalog-only ID to the adapter", async () => {
    const repository = new SeedRepository([entry({
      nativeSessionId: "catalog:diagnostic",
      probeable: false,
      compatibility: {
        status: "incompatible",
        readerVersion: "0.153.0",
        reasonCode: "CODEX_SESSION_SCHEMA_UNKNOWN",
        reason: "无法恢复可验证的 Codex 会话 ID",
      },
    })]);
    const runtime = adapter(async () => detail());
    const service = new CodexSessionCompatibilityService(runtime, catalog(repository));
    service.supplement([]);

    await expect(service.readSupplemental("catalog:diagnostic")).rejects.toMatchObject({
      code: "CODEX_SESSION_VERSION_INCOMPATIBLE",
    });
    expect(runtime.getSession).not.toHaveBeenCalled();
  });

  it("returns primary results without awaiting a stalled background scan", () => {
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const fileSystem: CodexSessionCatalogFileSystem = {
      listFiles: async () => { await stalled; return []; },
      realpath: async (path) => path,
      stat: async () => ({ isFile: () => true, size: 0, mtimeNs: "0" }),
      readMetadata: async () => ({ text: "", bytesRead: 0, complete: true }),
      watch: () => null,
    };
    const service = new CodexSessionCompatibilityService(
      adapter(async () => detail()),
      catalog(new SeedRepository([]), fileSystem),
    );

    service.start();
    expect(service.supplement([])).toEqual([]);
    release();
    service.dispose();
  });
});

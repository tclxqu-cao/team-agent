import { createHash } from "node:crypto";
import { basename, resolve, win32 } from "node:path";
import type {
  AgentRuntimeAdapter,
  AgentType,
  AgentWorkspace,
  ImportedAgentWorkspace,
  ImportedAgentWorkspaceRepository,
  ImportAgentWorkspaceResult,
  UnifiedSessionSummary,
  WorkspacePage,
  WorkspaceQuery,
  WorkspaceSessionQuery,
} from "./types.js";
import { RuntimeSessionError } from "./types.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function workspacePageSize(limit?: number): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RuntimeSessionError(
      `Workspace page limit must be between 1 and ${MAX_PAGE_SIZE}`,
      "INVALID_SESSION_ID",
    );
  }
  return limit;
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeOffsetCursor(cursor?: string | null): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    if (!Number.isInteger(parsed.offset) || (parsed.offset as number) < 0) throw new Error("invalid offset");
    return parsed.offset as number;
  } catch {
    throw new RuntimeSessionError("Invalid workspace cursor", "INVALID_SESSION_ID");
  }
}

export function paginateByOffset<T>(
  data: readonly T[],
  query: { cursor?: string | null; limit?: number } = {},
  watermark: string | null = null,
): WorkspacePage<T> {
  const offset = decodeOffsetCursor(query.cursor);
  const limit = workspacePageSize(query.limit);
  const page = data.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    data: page,
    nextCursor: nextOffset < data.length ? encodeOffsetCursor(nextOffset) : null,
    watermark,
  };
}

export function normalizeAgentWorkspacePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RuntimeSessionError("A workspace directory is required", "INVALID_SESSION_ID");
  }
  if (platform !== "win32") return resolve(trimmed);
  const normalized = win32.resolve(trimmed);
  const root = win32.parse(normalized).root;
  return (normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized).toLowerCase();
}

export function importedWorkspaceId(agentType: AgentType, normalizedPath: string): string {
  const digest = createHash("sha256")
    .update(`${agentType}\0${normalizedPath}`)
    .digest("base64url")
    .slice(0, 24);
  return `imported:${digest}`;
}

function importedWorkspaceToDomain(
  workspace: ImportedAgentWorkspace,
  order: number,
): AgentWorkspace {
  return {
    agentType: workspace.agentType,
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    roots: [workspace.normalizedPath],
    order,
    updatedAt: new Date(workspace.createdAt).toISOString(),
    source: "imported",
  };
}

interface WorkspaceCatalog {
  data: AgentWorkspace[];
  watermark: string | null;
  stale?: boolean;
}

/** Application service that keeps workspace discovery isolated per Agent. */
export class AgentWorkspaceIndexService {
  private readonly adapters = new Map<AgentType, AgentRuntimeAdapter>();
  private readonly workspaceCache = new Map<AgentType, WorkspaceCatalog>();
  private readonly workspaceRequests = new Map<AgentType, Promise<WorkspaceCatalog>>();
  private readonly sessionCache = new Map<string, WorkspacePage<UnifiedSessionSummary>>();
  private readonly sessionRequests = new Map<string, Promise<WorkspacePage<UnifiedSessionSummary>>>();

  constructor(
    adapters: readonly AgentRuntimeAdapter[],
    private readonly importedWorkspaces?: ImportedAgentWorkspaceRepository,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.agentType, adapter);
  }

  async listWorkspaces(
    agentType: AgentType,
    query: WorkspaceQuery = {},
  ): Promise<WorkspacePage<AgentWorkspace>> {
    const adapter = this.requireWorkspaceAdapter(agentType);
    if (!query.refresh) {
      const cached = this.workspaceCache.get(agentType);
      if (cached) return { ...paginateByOffset(cached.data, query, cached.watermark), stale: cached.stale };
      const pending = this.workspaceRequests.get(agentType);
      if (pending) {
        const catalog = await pending;
        return { ...paginateByOffset(catalog.data, query, catalog.watermark), stale: catalog.stale };
      }
    }
    const request = this.loadWorkspaceCatalog(adapter, query);
    this.workspaceRequests.set(agentType, request);
    try {
      const catalog = await request;
      this.workspaceCache.set(agentType, catalog);
      return { ...paginateByOffset(catalog.data, query, catalog.watermark), stale: catalog.stale };
    } catch (error) {
      const cached = this.workspaceCache.get(agentType);
      if (cached) return { ...paginateByOffset(cached.data, query, cached.watermark), stale: true };
      throw error;
    } finally {
      if (this.workspaceRequests.get(agentType) === request) {
        this.workspaceRequests.delete(agentType);
      }
    }
  }

  async importWorkspace(
    agentType: AgentType,
    path: string,
    name?: string,
  ): Promise<ImportAgentWorkspaceResult> {
    const adapter = this.requireWorkspaceAdapter(agentType);
    if (!this.importedWorkspaces) {
      if (adapter.importWorkspace) {
        const result = await adapter.importWorkspace(path, name);
        this.invalidate(agentType);
        return result;
      }
      throw new RuntimeSessionError(
        `Runtime does not support workspace imports: ${agentType}`,
        "OPERATION_NOT_SUPPORTED",
      );
    }
    if (agentType === "customer-agent") {
      throw new RuntimeSessionError(
        "Customer Agent workspaces use the project repository",
        "OPERATION_NOT_SUPPORTED",
      );
    }
    const normalizedPath = normalizeAgentWorkspacePath(path, this.platform);
    const cached = this.workspaceCache.get(agentType)?.data.find((workspace) => workspace.roots.some(
      (root) => normalizeAgentWorkspacePath(root, this.platform) === normalizedPath,
    ));
    if (cached) return { workspace: cached, existing: true };
    const persisted = this.importedWorkspaces.findByPath(agentType, normalizedPath);

    try {
      const catalog = await this.loadWorkspaceCatalog(adapter, { refresh: true });
      const native = catalog.data.find((workspace) => workspace.source !== "imported" && workspace.roots.some(
        (root) => normalizeAgentWorkspacePath(root, this.platform) === normalizedPath,
      ));
      if (native) return { workspace: native, existing: true };
    } catch {
      // Registration remains available while a runtime is temporarily offline.
    }
    if (persisted) {
      return { workspace: importedWorkspaceToDomain(persisted, Number.MAX_SAFE_INTEGER), existing: true };
    }

    const createdAt = Date.now();
    const saved = this.importedWorkspaces.save({
      agentType,
      workspaceId: importedWorkspaceId(agentType, normalizedPath),
      normalizedPath,
      name: name?.trim() || basename(normalizedPath) || normalizedPath,
      createdAt,
    });
    this.invalidate(agentType);
    return {
      workspace: importedWorkspaceToDomain(saved.workspace, Number.MAX_SAFE_INTEGER),
      existing: saved.existing,
    };
  }

  async listWorkspaceSessions(
    agentType: AgentType,
    workspaceId: string,
    query: WorkspaceSessionQuery = {},
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    const adapter = this.requireWorkspaceAdapter(agentType);
    if (!adapter.listWorkspaceSessions) {
      throw new RuntimeSessionError(
        `Runtime does not expose workspace sessions: ${agentType}`,
        "OPERATION_NOT_SUPPORTED",
      );
    }
    const cacheKey = `${agentType}\0${workspaceId}\0${query.cursor ?? ""}`;
    if (!query.refresh) {
      const cached = this.sessionCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.sessionRequests.get(cacheKey);
      if (pending) return pending;
    }
    const imported = agentType === "customer-agent"
      ? null
      : this.importedWorkspaces?.list(agentType).find((workspace) => workspace.workspaceId === workspaceId) ?? null;
    const request = imported
      ? this.listImportedWorkspaceSessions(adapter, imported, query)
      : adapter.listWorkspaceSessions!(workspaceId, {
          ...query,
          limit: workspacePageSize(query.limit),
        });
    this.sessionRequests.set(cacheKey, request);
    try {
      const page = await request;
      this.sessionCache.set(cacheKey, page);
      return page;
    } catch (error) {
      const cached = this.sessionCache.get(cacheKey);
      if (cached) return { ...cached, stale: true };
      throw error;
    } finally {
      if (this.sessionRequests.get(cacheKey) === request) this.sessionRequests.delete(cacheKey);
    }
  }

  invalidate(agentType: AgentType, workspaceId?: string): void {
    this.workspaceCache.delete(agentType);
    if (!workspaceId) {
      for (const key of this.sessionCache.keys()) {
        if (key.startsWith(`${agentType}\0`)) this.sessionCache.delete(key);
      }
      return;
    }
    const prefix = `${agentType}\0${workspaceId}\0`;
    for (const key of this.sessionCache.keys()) {
      if (key.startsWith(prefix)) this.sessionCache.delete(key);
    }
  }

  private requireWorkspaceAdapter(agentType: AgentType): AgentRuntimeAdapter {
    const adapter = this.adapters.get(agentType);
    if (!adapter?.listWorkspaces) {
      throw new RuntimeSessionError(
        `Runtime does not expose workspaces: ${agentType}`,
        "OPERATION_NOT_SUPPORTED",
      );
    }
    return adapter;
  }

  private async loadWorkspaceCatalog(
    adapter: AgentRuntimeAdapter,
    query: WorkspaceQuery,
  ): Promise<WorkspaceCatalog> {
    const data: AgentWorkspace[] = [];
    let cursor: string | null = null;
    let watermark: string | null = null;
    let stale = false;
    do {
      const page = await adapter.listWorkspaces!({
        cursor,
        limit: MAX_PAGE_SIZE,
        refresh: query.refresh && cursor === null,
        since: cursor === null ? query.since : null,
      });
      data.push(...page.data);
      watermark = page.watermark ?? watermark;
      stale ||= page.stale === true;
      cursor = page.nextCursor;
    } while (cursor);

    if (!this.importedWorkspaces || adapter.agentType === "customer-agent") {
      return { data, watermark, ...(stale ? { stale: true } : {}) };
    }
    const nativeRoots = new Set(data.flatMap((workspace) => workspace.roots.map(
      (root) => normalizeAgentWorkspacePath(root, this.platform),
    )));
    const imports = this.importedWorkspaces
      .list(adapter.agentType)
      .filter((workspace) => !nativeRoots.has(workspace.normalizedPath))
      .map((workspace, index) => importedWorkspaceToDomain(workspace, data.length + index));
    return { data: [...data, ...imports], watermark, ...(stale ? { stale: true } : {}) };
  }

  private async listImportedWorkspaceSessions(
    adapter: AgentRuntimeAdapter,
    workspace: ImportedAgentWorkspace,
    query: WorkspaceSessionQuery,
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    if (!adapter.listWorkspaceSessionsByPath) {
      throw new RuntimeSessionError(
        `Runtime cannot query imported workspace sessions: ${adapter.agentType}`,
        "OPERATION_NOT_SUPPORTED",
      );
    }
    const page = await adapter.listWorkspaceSessionsByPath(workspace.normalizedPath, {
      ...query,
      limit: workspacePageSize(query.limit),
    });
    return {
      ...page,
      data: page.data.map((session) => ({ ...session, projectId: workspace.workspaceId })),
    };
  }
}

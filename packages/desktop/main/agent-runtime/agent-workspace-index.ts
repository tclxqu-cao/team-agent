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
export const CODEX_RECENT_WORKSPACE_ID = "codex:recent";

export interface SessionCatalog {
  byWorkspace: Map<string, UnifiedSessionSummary[]>;
  watermark: string | null;
}

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
  private codexSessionCatalog: SessionCatalog | null = null;
  private codexSessionCatalogRequest: Promise<SessionCatalog> | null = null;
  private codexSessionCatalogGeneration = 0;

  constructor(
    adapters: readonly AgentRuntimeAdapter[],
    private readonly importedWorkspaces?: ImportedAgentWorkspaceRepository,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly supplementCodexSessions?: (
      primary: readonly UnifiedSessionSummary[],
    ) => UnifiedSessionSummary[],
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
      if (query.refresh && agentType === "codex") this.clearSessionCache(agentType);
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
    const request = agentType === "codex"
      ? this.listCodexWorkspaceSessions(adapter, workspaceId, query)
      : imported
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
      this.clearSessionCache(agentType);
      return;
    }
    if (agentType === "codex") this.resetCodexSessionCatalog();
    const prefix = `${agentType}\0${workspaceId}\0`;
    for (const key of this.sessionCache.keys()) {
      if (key.startsWith(prefix)) this.sessionCache.delete(key);
    }
  }

  private clearSessionCache(agentType: AgentType): void {
    this.deleteSessionCacheEntries(agentType);
    if (agentType === "codex") this.resetCodexSessionCatalog();
  }

  private deleteSessionCacheEntries(agentType: AgentType): void {
    for (const key of this.sessionCache.keys()) {
      if (key.startsWith(`${agentType}\0`)) this.sessionCache.delete(key);
    }
  }

  private resetCodexSessionCatalog(): void {
    this.codexSessionCatalogGeneration += 1;
    this.codexSessionCatalog = null;
    this.codexSessionCatalogRequest = null;
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

    let combined = data;
    if (this.importedWorkspaces && adapter.agentType !== "customer-agent") {
      const nativeRoots = new Set(data.flatMap((workspace) => workspace.roots.map(
        (root) => normalizeAgentWorkspacePath(root, this.platform),
      )));
      const imports = this.importedWorkspaces
        .list(adapter.agentType)
        .filter((workspace) => !nativeRoots.has(workspace.normalizedPath))
        .map((workspace, index) => importedWorkspaceToDomain(workspace, data.length + index));
      combined = [...data, ...imports];
    }
    if (adapter.agentType === "codex") {
      combined = [{
        agentType: "codex",
        workspaceId: CODEX_RECENT_WORKSPACE_ID,
        name: "最近",
        roots: [],
        order: -1,
        source: "derived",
        canCreateSession: false,
      }, ...combined];
    }
    return { data: combined, watermark, ...(stale ? { stale: true } : {}) };
  }

  private async listCodexWorkspaceSessions(
    adapter: AgentRuntimeAdapter,
    workspaceId: string,
    query: WorkspaceSessionQuery,
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    const catalog = await this.getCodexSessionCatalog(adapter, query.refresh === true);
    const sessions = catalog.byWorkspace.get(workspaceId);
    if (!sessions) {
      throw new RuntimeSessionError(`Codex workspace not found: ${workspaceId}`, "SESSION_NOT_FOUND");
    }
    return paginateByOffset(sessions, query, catalog.watermark);
  }

  private async getCodexSessionCatalog(
    adapter: AgentRuntimeAdapter,
    refresh: boolean,
  ): Promise<SessionCatalog> {
    if (refresh) this.resetCodexSessionCatalog();
    if (!refresh && this.codexSessionCatalog) return this.codexSessionCatalog;
    if (!refresh && this.codexSessionCatalogRequest) return this.codexSessionCatalogRequest;
    const generation = this.codexSessionCatalogGeneration;
    const request = this.loadCodexSessionCatalog(adapter);
    this.codexSessionCatalogRequest = request;
    try {
      const catalog = await request;
      if (generation !== this.codexSessionCatalogGeneration) {
        return this.getCodexSessionCatalog(adapter, false);
      }
      if (refresh) this.deleteSessionCacheEntries("codex");
      this.codexSessionCatalog = catalog;
      return catalog;
    } finally {
      if (this.codexSessionCatalogRequest === request) this.codexSessionCatalogRequest = null;
    }
  }

  private async loadCodexSessionCatalog(adapter: AgentRuntimeAdapter): Promise<SessionCatalog> {
    if (!this.workspaceCache.has("codex")) {
      await this.listWorkspaces("codex", { limit: MAX_PAGE_SIZE });
    }
    const workspaces = this.workspaceCache.get("codex")?.data;
    if (!workspaces) {
      throw new RuntimeSessionError("Codex workspace catalog is unavailable", "RUNTIME_UNAVAILABLE");
    }
    const primary = await adapter.discoverSessions();
    const discovered = this.supplementCodexSessions?.(primary) ?? primary;
    return classifyCodexSessions(discovered, workspaces, this.platform);
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

export function classifyCodexSessions(
  sessions: readonly UnifiedSessionSummary[],
  workspaces: readonly AgentWorkspace[],
  platform: NodeJS.Platform = process.platform,
): SessionCatalog {
  const candidates = workspaces.filter((workspace) => workspace.workspaceId !== CODEX_RECENT_WORKSPACE_ID);
  const byId = new Map(candidates.map((workspace) => [workspace.workspaceId, workspace]));
  const roots = candidates.flatMap((workspace) => workspace.roots.flatMap((root) => {
    if (!root.trim()) return [];
    try {
      return [{ workspaceId: workspace.workspaceId, path: normalizeAgentWorkspacePath(root, platform) }];
    } catch {
      return [];
    }
  })).sort((left, right) => right.path.length - left.path.length);
  const byWorkspace = new Map<string, UnifiedSessionSummary[]>(
    workspaces.map((workspace) => [workspace.workspaceId, []]),
  );
  const ordered = [...sessions]
    .sort((left, right) => right.updated.localeCompare(left.updated) || left.id.localeCompare(right.id));
  const seen = new Set<string>();
  for (const session of ordered) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    let workspaceId = session.projectId && byId.has(session.projectId) ? session.projectId : undefined;
    if (!workspaceId && session.cwd.trim()) {
      try {
        const cwd = normalizeAgentWorkspacePath(session.cwd, platform);
        workspaceId = roots.find((root) => pathContains(root.path, cwd, platform))?.workspaceId;
      } catch {
        // Invalid historical paths remain available through the recent workspace.
      }
    }
    workspaceId ??= CODEX_RECENT_WORKSPACE_ID;
    const target = byWorkspace.get(workspaceId) ?? byWorkspace.get(CODEX_RECENT_WORKSPACE_ID);
    target?.push({ ...session, projectId: workspaceId });
  }
  return {
    byWorkspace,
    watermark: ordered[0]?.updated ?? null,
  };
}

function pathContains(root: string, cwd: string, platform: NodeJS.Platform): boolean {
  if (root === cwd) return true;
  const separator = platform === "win32" ? "\\" : "/";
  return cwd.startsWith(`${root}${separator}`);
}

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
const CODEX_NATIVE_CURSOR_PREFIX = "codex-native:";
const CODEX_CATALOG_CURSOR_PREFIX = "codex-catalog:";
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

type CodexCursor =
  | { kind: "native"; value: string }
  | { kind: "catalog"; value: string };

function encodeCodexCursor(kind: CodexCursor["kind"], value: string): string {
  const prefix = kind === "native" ? CODEX_NATIVE_CURSOR_PREFIX : CODEX_CATALOG_CURSOR_PREFIX;
  return `${prefix}${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeTaggedCodexCursor(cursor: string, prefix: string): string {
  const encoded = cursor.slice(prefix.length);
  const value = Buffer.from(encoded, "base64url").toString("utf8");
  if (!encoded || !value || Buffer.from(value, "utf8").toString("base64url") !== encoded) {
    throw new RuntimeSessionError("Invalid Codex workspace cursor", "INVALID_SESSION_ID");
  }
  return value;
}

function decodeCodexCursor(cursor?: string | null): CodexCursor | null {
  if (!cursor) return null;
  if (cursor.startsWith(CODEX_NATIVE_CURSOR_PREFIX)) {
    return { kind: "native", value: decodeTaggedCodexCursor(cursor, CODEX_NATIVE_CURSOR_PREFIX) };
  }
  if (cursor.startsWith(CODEX_CATALOG_CURSOR_PREFIX)) {
    return { kind: "catalog", value: decodeTaggedCodexCursor(cursor, CODEX_CATALOG_CURSOR_PREFIX) };
  }
  try {
    decodeOffsetCursor(cursor);
    return { kind: "catalog", value: cursor };
  } catch {
    return { kind: "native", value: cursor };
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

function paginateCodexCatalog<T>(
  data: readonly T[],
  query: WorkspaceSessionQuery,
  watermark: string | null,
): WorkspacePage<T> {
  const cursor = decodeCodexCursor(query.cursor);
  if (cursor?.kind === "native") {
    throw new RuntimeSessionError("Native Codex cursor cannot page the classified catalog", "INVALID_SESSION_ID");
  }
  const page = paginateByOffset(data, { ...query, cursor: cursor?.value ?? null }, watermark);
  return {
    ...page,
    nextCursor: page.nextCursor ? encodeCodexCursor("catalog", page.nextCursor) : null,
  };
}

function wrapCodexNativePage<T>(page: WorkspacePage<T>): WorkspacePage<T> {
  return {
    ...page,
    nextCursor: page.nextCursor ? encodeCodexCursor("native", page.nextCursor) : null,
  };
}

function mergeSessionRows(
  fresh: readonly UnifiedSessionSummary[],
  existing: readonly UnifiedSessionSummary[],
  workspaceId: string,
): UnifiedSessionSummary[] {
  const freshIds = new Set(fresh.map((session) => session.id));
  return [
    ...fresh.map((session) => ({ ...session, projectId: workspaceId })),
    ...existing.filter((session) => !freshIds.has(session.id)),
  ].sort((left, right) => right.updated.localeCompare(left.updated) || left.id.localeCompare(right.id));
}

function codexWorkspaceClassificationKey(
  workspaces: readonly AgentWorkspace[],
  platform: NodeJS.Platform,
): string {
  return JSON.stringify(workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    source: workspace.source,
    roots: workspace.roots.map((root) => normalizeAgentWorkspacePath(root, platform)).sort(),
  })).sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)));
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
  aliases?: ReadonlyMap<string, string>;
  mergedNativePaths?: ReadonlyMap<string, string>;
}

function deduplicateNativeWorkspacesByRoots(
  workspaces: readonly AgentWorkspace[],
  platform: NodeJS.Platform,
): {
  data: AgentWorkspace[];
  aliases: Map<string, string>;
  mergedNativePaths: Map<string, string>;
} {
  const data: AgentWorkspace[] = [];
  const groups = new Map<string, { index: number; members: AgentWorkspace[] }>();

  for (const workspace of workspaces) {
    const roots = workspace.roots.flatMap((root) => {
      try {
        return root.trim() ? [normalizeAgentWorkspacePath(root, platform)] : [];
      } catch {
        return [];
      }
    }).sort();
    if (workspace.source !== "native" || roots.length === 0) {
      data.push(workspace);
      continue;
    }
    const key = JSON.stringify(roots);
    const group = groups.get(key);
    if (group) {
      group.members.push(workspace);
      continue;
    }
    groups.set(key, { index: data.length, members: [workspace] });
    data.push(workspace);
  }

  const aliases = new Map<string, string>();
  const mergedNativePaths = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.members.length < 2) continue;
    const canonical = [...group.members].sort((left, right) => (
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
      || left.order - right.order
      || left.workspaceId.localeCompare(right.workspaceId)
    ))[0]!;
    data[group.index] = canonical;
    for (const member of group.members) {
      if (member.workspaceId !== canonical.workspaceId) aliases.set(member.workspaceId, canonical.workspaceId);
    }
    if (canonical.roots.length === 1) {
      mergedNativePaths.set(canonical.workspaceId, normalizeAgentWorkspacePath(canonical.roots[0]!, platform));
    }
  }
  return { data, aliases, mergedNativePaths };
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
  private readonly codexDirectSessions = new Map<string, UnifiedSessionSummary[]>();
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
      const previous = this.workspaceCache.get(agentType);
      const catalog = await request;
      this.workspaceCache.set(agentType, catalog);
      if (
        query.refresh
        && agentType === "codex"
        && previous
        && codexWorkspaceClassificationKey(previous.data, this.platform)
          !== codexWorkspaceClassificationKey(catalog.data, this.platform)
      ) this.clearSessionCache(agentType);
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
    this.codexDirectSessions.clear();
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

    const deduplicated = adapter.agentType === "codex"
      ? deduplicateNativeWorkspacesByRoots(data, this.platform)
      : { data, aliases: new Map<string, string>(), mergedNativePaths: new Map<string, string>() };
    let combined = deduplicated.data;
    if (this.importedWorkspaces && adapter.agentType !== "customer-agent") {
      const nativeRoots = new Set(combined.flatMap((workspace) => workspace.roots.map(
        (root) => normalizeAgentWorkspacePath(root, this.platform),
      )));
      const imports = this.importedWorkspaces
        .list(adapter.agentType)
        .filter((workspace) => !nativeRoots.has(workspace.normalizedPath))
        .map((workspace, index) => importedWorkspaceToDomain(workspace, combined.length + index));
      combined = [...combined, ...imports];
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
    return {
      data: combined,
      watermark,
      ...(stale ? { stale: true } : {}),
      ...(deduplicated.aliases.size ? { aliases: deduplicated.aliases } : {}),
      ...(deduplicated.mergedNativePaths.size ? { mergedNativePaths: deduplicated.mergedNativePaths } : {}),
    };
  }

  private async listCodexWorkspaceSessions(
    adapter: AgentRuntimeAdapter,
    workspaceId: string,
    query: WorkspaceSessionQuery,
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    if (!this.workspaceCache.has("codex")) {
      await this.listWorkspaces("codex", { limit: MAX_PAGE_SIZE });
    }
    const workspace = this.workspaceCache.get("codex")?.data.find(
      (candidate) => candidate.workspaceId === workspaceId,
    );
    if (!workspace) {
      throw new RuntimeSessionError(`Codex workspace not found: ${workspaceId}`, "SESSION_NOT_FOUND");
    }

    const cursor = decodeCodexCursor(query.cursor);
    if (workspace.source === "native" && cursor?.kind !== "catalog") {
      const mergedPath = this.workspaceCache.get("codex")?.mergedNativePaths?.get(workspaceId);
      const direct = mergedPath && adapter.listWorkspaceSessionsByPath
        ? await adapter.listWorkspaceSessionsByPath(mergedPath, {
          ...query,
          cursor: cursor?.value ?? null,
          limit: workspacePageSize(query.limit),
        })
        : await adapter.listWorkspaceSessions!(workspaceId, {
          ...query,
          cursor: cursor?.value ?? null,
          limit: workspacePageSize(query.limit),
        });
      const canonicalDirect = {
        ...direct,
        data: direct.data.map((session) => ({ ...session, projectId: workspaceId })),
      };
      this.rememberCodexDirectSessions(workspaceId, canonicalDirect.data);
      if (!query.cursor && this.codexSessionCatalog) {
        const sessions = this.codexSessionCatalog.byWorkspace.get(workspaceId) ?? [];
        return paginateCodexCatalog(sessions, query, this.codexSessionCatalog.watermark);
      }
      void this.getCodexSessionCatalog(adapter, false).catch(() => undefined);
      return wrapCodexNativePage(canonicalDirect);
    }

    const refresh = query.refresh === true && !query.cursor;
    const catalog = await this.getCodexSessionCatalog(adapter, refresh);
    const sessions = catalog.byWorkspace.get(workspaceId);
    if (!sessions) {
      throw new RuntimeSessionError(`Codex workspace not found: ${workspaceId}`, "SESSION_NOT_FOUND");
    }
    return paginateCodexCatalog(sessions, query, catalog.watermark);
  }

  private rememberCodexDirectSessions(
    workspaceId: string,
    sessions: readonly UnifiedSessionSummary[],
  ): void {
    const merged = mergeSessionRows(sessions, this.codexDirectSessions.get(workspaceId) ?? [], workspaceId);
    this.codexDirectSessions.set(workspaceId, merged);
    if (!this.codexSessionCatalog?.byWorkspace.has(workspaceId)) return;
    const catalogRows = this.codexSessionCatalog.byWorkspace.get(workspaceId) ?? [];
    this.codexSessionCatalog.byWorkspace.set(workspaceId, mergeSessionRows(merged, catalogRows, workspaceId));
    const newest = this.codexSessionCatalog.byWorkspace.get(workspaceId)?.[0]?.updated;
    if (newest && (!this.codexSessionCatalog.watermark || newest > this.codexSessionCatalog.watermark)) {
      this.codexSessionCatalog.watermark = newest;
    }
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
      this.codexSessionCatalog = catalog;
      this.deleteSessionCacheEntries("codex");
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
    const aliases = this.workspaceCache.get("codex")?.aliases;
    const catalog = classifyCodexSessions(discovered, workspaces, this.platform, aliases);
    for (const [workspaceId, direct] of this.codexDirectSessions) {
      const existing = catalog.byWorkspace.get(workspaceId);
      if (!existing) continue;
      catalog.byWorkspace.set(workspaceId, mergeSessionRows(direct, existing, workspaceId));
      const newest = catalog.byWorkspace.get(workspaceId)?.[0]?.updated;
      if (newest && (!catalog.watermark || newest > catalog.watermark)) catalog.watermark = newest;
    }
    return catalog;
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
  workspaceAliases: ReadonlyMap<string, string> = new Map(),
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
    const aliasedProjectId = session.projectId ? workspaceAliases.get(session.projectId) : undefined;
    let workspaceId = aliasedProjectId && byId.has(aliasedProjectId)
      ? aliasedProjectId
      : session.projectId && byId.has(session.projectId) ? session.projectId : undefined;
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

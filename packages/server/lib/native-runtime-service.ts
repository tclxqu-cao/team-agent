import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentEvent } from "@agent/core";
import { ClaudeRuntimeAdapter } from "../../desktop/main/agent-runtime/claude-runtime-adapter.js";
import { CodexAppServerClient } from "../../desktop/main/agent-runtime/codex-app-server-client.js";
import { CodexRuntimeAdapter } from "../../desktop/main/agent-runtime/codex-runtime-adapter.js";
import { decodeUnifiedSessionId } from "../../desktop/main/agent-runtime/session-id.js";
import { RuntimeSessionError } from "../../desktop/main/agent-runtime/types.js";
import type {
  AgentType,
  CreateRuntimeSessionOptions,
  RuntimeHealth,
  RuntimeQuestionAnswer,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
} from "../../desktop/main/agent-runtime/types.js";
import { UnifiedSessionService } from "../../desktop/main/agent-runtime/unified-session-service.js";

const globalWithService = globalThis as typeof globalThis & {
  __nativeRuntimeService?: NativeRuntimeService;
};

// The agentroam launchd job starts this server with PATH=/usr/bin:/bin:/usr/sbin:/sbin,
// which lacks the directories where codex/claude CLIs are installed — spawning them
// fails with ENOENT. Append the usual install locations (existing PATH wins).
function ensureNativeCliPath(): void {
  const candidates = [
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const current = (process.env.PATH ?? "").split(delimiter);
  const missing = candidates.filter((dir) => existsSync(dir) && !current.includes(dir));
  if (missing.length > 0) {
    process.env.PATH = [...current, ...missing].join(delimiter);
  }
}

/** Operations the web application needs from a native runtime host. */
export interface NativeRuntimePort {
  health(): Promise<RuntimeHealth[]>;
  list(projectId?: string): Promise<UnifiedSessionSummary[]>;
  refresh(projectId?: string): Promise<UnifiedSessionSummary[]>;
  create(options: CreateRuntimeSessionOptions & { agentType: AgentType }): Promise<UnifiedSessionSummary>;
  get(id: string): Promise<UnifiedSessionDetail>;
  run(id: string, input: string, images?: string[], agentIds?: string[], agentName?: string): AsyncIterable<AgentEvent>;
  abort(id?: string): Promise<void>;
  answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
}

/**
 * Application service over the domain's UnifiedSessionService.
 *
 * Owns one piece of web-specific domain state: sessions this server created
 * that the native runtime cannot discover yet. Codex `thread/list` hides
 * threads until their first turn runs, so a freshly created session would
 * vanish from listings (and from the client's selection) until then. Pending
 * creations are merged into project-less listings and promoted out of the
 * registry once real discovery returns them.
 */
export class NativeRuntimeService implements NativeRuntimePort {
  private readonly pendingCreations = new Map<string, UnifiedSessionSummary>();

  constructor(private readonly runtime: Pick<NativeRuntimePort, keyof NativeRuntimePort>) {}

  health(): Promise<RuntimeHealth[]> {
    return this.runtime.health();
  }

  async list(projectId?: string): Promise<UnifiedSessionSummary[]> {
    return this.withPendingCreations(await this.runtime.list(projectId), projectId);
  }

  async refresh(projectId?: string): Promise<UnifiedSessionSummary[]> {
    return this.withPendingCreations(await this.runtime.refresh(projectId), projectId);
  }

  async create(options: CreateRuntimeSessionOptions & { agentType: AgentType }): Promise<UnifiedSessionSummary> {
    const created = await this.runtime.create(options);
    this.pendingCreations.set(created.id, created);
    return created;
  }

  async get(id: string): Promise<UnifiedSessionDetail> {
    try {
      return await this.runtime.get(id);
    } catch (error) {
      const pending = this.pendingCreations.get(id);
      if (!pending) throw error;
      return { ...pending, messages: [], events: [] };
    }
  }

  run(id: string, input: string, images?: string[], agentIds?: string[], agentName?: string): AsyncIterable<AgentEvent> {
    return this.runtime.run(id, input, images, agentIds, agentName);
  }

  abort(id?: string): Promise<void> {
    return this.runtime.abort(id);
  }

  answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    return this.runtime.answerQuestion(questionId, answer);
  }

  private withPendingCreations(
    discovered: UnifiedSessionSummary[],
    projectId?: string,
  ): UnifiedSessionSummary[] {
    // Pending sessions have no project association; project-scoped queries
    // must not leak them into other projects' lists.
    if (projectId !== undefined) return discovered;
    const discoveredIds = new Set<string>();
    for (const session of discovered) {
      discoveredIds.add(session.id);
      this.pendingCreations.delete(session.id);
    }
    const merged = [...discovered];
    for (const pending of this.pendingCreations.values()) {
      if (!discoveredIds.has(pending.id)) merged.push(pending);
    }
    return merged.sort((left, right) => right.updated.localeCompare(left.updated));
  }
}

/**
 * Server-side native runtime service hosting only the external native
 * runtimes (Codex / Claude Code). The customer-agent runtime is owned by
 * agent-host + SQLite and is never registered here, so native session IDs
 * are the only ones this service ever sees.
 *
 * The globalThis guard keeps dev HMR from spawning duplicate codex
 * app-server processes across module reloads.
 */
export function getNativeRuntimeService(): NativeRuntimeService {
  if (!globalWithService.__nativeRuntimeService) {
    ensureNativeCliPath();
    const codexClient = new CodexAppServerClient({
      executable: process.env.AGENT_CODEX_BIN?.trim() || "codex",
    });
    const unified = new UnifiedSessionService(
      [new CodexRuntimeAdapter({ client: codexClient }), new ClaudeRuntimeAdapter()],
      // The web server registers no projects; native sessions without a
      // matching project root render under "其他本机会话".
      () => Promise.resolve([]),
    );
    globalWithService.__nativeRuntimeService = new NativeRuntimeService(unified);
  }
  return globalWithService.__nativeRuntimeService;
}

/** True for unified IDs that belong to an external native runtime. */
export function isNativeSessionId(id: string): boolean {
  try {
    return decodeUnifiedSessionId(id).agentType !== "customer-agent";
  } catch {
    return false;
  }
}

export function runtimeErrorStatus(err: unknown): number {
  if (err instanceof RuntimeSessionError) {
    switch (err.code) {
      case "SESSION_NOT_FOUND":
        return 404;
      case "SESSION_OCCUPIED":
        return 409;
      case "RUNTIME_UNAVAILABLE":
        return 503;
      case "OPERATION_NOT_SUPPORTED":
        return 405;
      default:
        return 400;
    }
  }
  return 500;
}

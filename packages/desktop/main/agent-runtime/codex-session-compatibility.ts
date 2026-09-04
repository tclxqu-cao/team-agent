import type { AgentRuntimeAdapter, UnifiedSessionDetail, UnifiedSessionSummary } from "./types.js";
import { RuntimeSessionError } from "./types.js";
import {
  CodexSessionDiskCatalog,
  type CodexDiskSessionCatalogEntry,
} from "./codex-session-disk-catalog.js";

export class CodexSessionCompatibilityService {
  private primaryNativeSessionIds = new Set<string>();

  constructor(
    private readonly adapter: AgentRuntimeAdapter,
    private readonly catalog: CodexSessionDiskCatalog,
  ) {}

  start(): void {
    this.catalog.start();
  }

  supplement(primary: readonly UnifiedSessionSummary[]): UnifiedSessionSummary[] {
    this.primaryNativeSessionIds = new Set(primary.map((session) => session.nativeSessionId));
    const supplemental = this.catalog.summaries().filter(
      (session) => !this.primaryNativeSessionIds.has(session.nativeSessionId),
    );
    return [...primary, ...supplemental];
  }

  isSupplemental(nativeSessionId: string): boolean {
    return !this.primaryNativeSessionIds.has(nativeSessionId)
      && this.catalog.findByNativeSessionId(nativeSessionId) !== undefined;
  }

  async readSupplemental(nativeSessionId: string): Promise<UnifiedSessionDetail> {
    const entry = this.catalog.findByNativeSessionId(nativeSessionId);
    if (!entry || this.primaryNativeSessionIds.has(nativeSessionId)) {
      throw new RuntimeSessionError("Codex session is not a supplemental catalog entry", "SESSION_NOT_FOUND");
    }
    if (!entry.probeable) {
      throw this.incompatibleError(entry, entry.compatibility.reason ?? "无法恢复可验证的 Codex 会话 ID");
    }
    try {
      const detail = await this.adapter.getSession(nativeSessionId);
      this.catalog.updateCompatibility(nativeSessionId, {
        status: "direct",
        readerVersion: entry.compatibility.readerVersion,
        ...(entry.producerVersion ? { producerVersion: entry.producerVersion } : {}),
        ...(entry.formatKey ? { formatKey: entry.formatKey } : {}),
      });
      return detail;
    } catch (error) {
      if (error instanceof RuntimeSessionError && error.code === "RUNTIME_UNAVAILABLE") {
        const reason = `Codex ${entry.compatibility.readerVersion} 当前不可用，无法验证该会话`;
        this.catalog.updateCompatibility(nativeSessionId, {
          status: "incompatible",
          readerVersion: entry.compatibility.readerVersion,
          ...(entry.producerVersion ? { producerVersion: entry.producerVersion } : {}),
          ...(entry.formatKey ? { formatKey: entry.formatKey } : {}),
          reasonCode: "CODEX_SESSION_RUNTIME_UNAVAILABLE",
          reason,
        });
        throw new RuntimeSessionError(reason, "CODEX_SESSION_VERSION_INCOMPATIBLE");
      }
      const reason = entry.producerVersion
        ? `该会话由 Codex ${entry.producerVersion} 创建，当前 Codex ${entry.compatibility.readerVersion} 无法读取`
        : `当前 Codex ${entry.compatibility.readerVersion} 无法读取该会话的历史格式`;
      this.catalog.updateCompatibility(nativeSessionId, {
        status: "incompatible",
        readerVersion: entry.compatibility.readerVersion,
        ...(entry.producerVersion ? { producerVersion: entry.producerVersion } : {}),
        ...(entry.formatKey ? { formatKey: entry.formatKey } : {}),
        reasonCode: "CODEX_SESSION_DIRECT_READ_FAILED",
        reason,
      });
      throw new RuntimeSessionError(reason, "CODEX_SESSION_VERSION_INCOMPATIBLE");
    }
  }

  dispose(): void {
    this.catalog.dispose();
  }

  private incompatibleError(
    entry: CodexDiskSessionCatalogEntry,
    reason: string,
  ): RuntimeSessionError {
    this.catalog.updateCompatibility(entry.nativeSessionId, {
      ...entry.compatibility,
      status: "incompatible",
      reasonCode: entry.compatibility.reasonCode ?? "CODEX_SESSION_SCHEMA_UNKNOWN",
      reason,
    });
    return new RuntimeSessionError(reason, "CODEX_SESSION_VERSION_INCOMPATIBLE");
  }
}

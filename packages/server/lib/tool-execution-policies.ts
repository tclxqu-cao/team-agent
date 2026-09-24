import {
  SQLiteToolExecutionPolicyStore,
  toolExecutionPolicySummary,
  validateToolExecutionPolicy,
  type StoredToolExecutionPolicy,
  type ToolExecutionPolicy,
  type ToolExecutionPolicySummary,
  ToolExecutionPolicyError,
} from "@agent/core";
import { getServerBaseDir } from "./server-data-dir";
import { runtimeToolIds } from "./runtime-tool-catalog";

export class ToolExecutionPolicyService {
  readonly store: SQLiteToolExecutionPolicyStore;

  constructor(baseDir: string = getServerBaseDir()) {
    this.store = new SQLiteToolExecutionPolicyStore(baseDir);
  }

  list(): Promise<StoredToolExecutionPolicy[]> {
    return this.store.list();
  }

  get(id: string): Promise<StoredToolExecutionPolicy | null> {
    return this.store.get(id);
  }

  async summaries(): Promise<ToolExecutionPolicySummary[]> {
    return (await this.store.list()).filter((policy) => policy.enabled).map(toolExecutionPolicySummary);
  }

  save(value: unknown, knownTools?: Iterable<string>): Promise<StoredToolExecutionPolicy> {
    const policy = validateToolExecutionPolicy(value, { knownTools, requireExecutables: true });
    return this.store.save(policy);
  }

  delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }
}

let singleton: ToolExecutionPolicyService | undefined;

export function toolExecutionPolicies(): ToolExecutionPolicyService {
  return singleton ??= new ToolExecutionPolicyService();
}

export function knownToolIds(): string[] {
  return runtimeToolIds();
}

export function toolPolicyErrorResponse(error: unknown): Response {
  const status = error instanceof ToolExecutionPolicyError ? 422 : 400;
  return Response.json({
    error: error instanceof Error ? error.message : "Tool policy request failed",
    code: error instanceof ToolExecutionPolicyError ? error.code : "INVALID_TOOL_POLICY",
  }, { status });
}

export type { ToolExecutionPolicy };

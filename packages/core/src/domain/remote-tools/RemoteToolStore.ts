import type { RemoteToolDefinition, RemoteToolJob, RemoteToolRegistration } from "./entities.js";

export interface RemoteToolStore {
  upsertTools(projectId: string, tools: RemoteToolRegistration[]): RemoteToolDefinition[];
  listEnabledTools(projectId: string): RemoteToolDefinition[];
  getTool(projectId: string, scheme: string): RemoteToolDefinition | null;
  createJob(projectId: string, scheme: string, requestPayload: Record<string, unknown>): RemoteToolJob;
  markJobRunning(id: string): void;
  markJobSucceeded(id: string, responsePayload: Record<string, unknown>): void;
  markJobFailed(id: string, error: string): void;
  getJob(id: string): RemoteToolJob | null;
}

export type RemoteToolMethod = "POST";
export type RemoteToolJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface RemoteToolRegistration {
  scheme: string;
  purpose: string;
  url: string;
  method?: RemoteToolMethod;
  headers?: Record<string, string>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  examples?: Array<Record<string, unknown>>;
  auth?: Record<string, unknown>;
}

export interface RemoteToolDefinition extends Required<Omit<RemoteToolRegistration, "method" | "headers" | "inputSchema" | "outputSchema" | "examples" | "auth">> {
  id: string;
  projectId: string;
  method: RemoteToolMethod;
  headers: Record<string, string>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  examples: Array<Record<string, unknown>>;
  auth: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteToolJob {
  id: string;
  projectId: string;
  scheme: string;
  requestPayload: Record<string, unknown>;
  status: RemoteToolJobStatus;
  responsePayload: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
